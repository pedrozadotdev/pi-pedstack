---
title: System Prompt Injection via `before_agent_start` with Parallel Pending State Channels
category: workflow
severity: medium
tags:
  - pi-extension
  - before-agent-start
  - pending-state
  - system-prompt-injection
  - pipeline-discipline
  - stage-key-extraction
  - handler-contract
  - pedstack
  - test-file-splitting
applies_when:
  - Injecting dynamic content into the system prompt before an agent turn
  - Using pi.on("before_agent_start") to set skill context, pipeline discipline, or domain-specific instructions
  - Extending an existing before_agent_start handler to support multiple independent injection sources
  - Needing to extract stage keys from SKILL.md paths in a cross-platform way
  - Enforcing pipeline discipline (no direct-to-implementation) via system prompt
  - Splitting oversized test files into domain-specific units
  - Reviewing code that manipulates system prompt chaining
---

# Problem

Pi extensions often need to inject dynamic content into the system prompt before the agent runs. The `pi.on("before_agent_start")` event provides the hook, but:

1. **Single-channel limitations**: When only one pending state variable exists (e.g., `pendingSkillPath`), adding a second independent injection source (e.g., fix-issues fetch instruction) requires either combining state into one blob or adding a second event handler — both fragile.

2. **Ordered block composition**: Multiple injection sources need a deterministic order (guard → instruction → data-fetch), with each block independently gated on state conditions. Simple string concatenation at the call site creates testability and ordering problems.

3. **Stage key extraction across platforms**: SKILL.md paths may use POSIX (`/`) or Windows (`\\`) separators. A regex that only handles one breaks on the other.

4. **Handler return contract confusion**: Returning `{ systemPrompt: event.systemPrompt + "" }` (empty append) is semantically different from returning `undefined` — the former breaks event-handler chaining while the latter preserves it.

5. **Test file bloat**: Adding tests for multiple pending state channels, block composition, path parsing, and handler integration inflates a single test file beyond the 800-line project limit.

# Context

This pattern was discovered during the `pi-pedstack` ce-core extension `/ped-fix-issues` command implementation (see [source plan](../../docs/plans/2026-06-14-ped-fix-issues-command-plan.md) and [source brainstorm](../../docs/brainstorms/2026-06-14-ped-fix-issues-command-requirements.md)). The extension already had a working `before_agent_start` handler with a single `pendingSkillPath` channel. Adding a second `pendingFixIssues` channel demonstrated the need for a structured injection pattern.

The upstream solution [replacing-implicit-input-interception-with-explicit-commands.md](./replacing-implicit-input-interception-with-explicit-commands.md) documents the command factory and session traversal patterns that this injection mechanism complements.

# Solution

## 1. Multi-channel pending state with asymmetric absent-markers

Use separate module-level variables for each injection channel. Use `null` for optional/absence semantics and `[]` for collection semantics:

```typescript
let pendingSkillPath: string | null = null;     // null = no skill path
let pendingFixIssues: string[] = [];            // [] = no issues

export function setPendingSkillPath(path: string | null): void {
  pendingSkillPath = path;
}
export function getAndClearPendingSkillPath(): string | null {
  const p = pendingSkillPath;
  pendingSkillPath = null;
  return p;
}

export function setPendingFixIssues(numbers: string[]): void {
  pendingFixIssues = [...numbers];  // defensive copy
}
export function getAndClearPendingFixIssues(): string[] {
  const n = pendingFixIssues;
  pendingFixIssues = [];
  return n;
}

/** Reset ALL channels (call in test afterEach / session cleanup). */
export function resetPedstackState(): void {
  pendingSkillPath = null;
  pendingFixIssues = [];
}
```

**Key rules:**
- **Last-write-wins** per channel; channels are independent
- **Defensive copy** on set (mutation safety — caller mutating input after set does not affect stored state)
- **Asymmetric absent-markers**: `null` for optional scalar, `[]` for collection. Both evaluate falsy, so `if (!skillPath && fixIssues.length === 0)` works as the empty check.
- **Reset function** clears ALL channels for test isolation

## 2. Pure function for ordered block composition

Extract block construction into a pure function that takes all channels as inputs and returns the composed string:

```typescript
/**
 * Build the system prompt append block for pending state.
 * Injection order: Pipeline Discipline guard → skill-reading → domain-specific fetch.
 * Returns empty string when nothing to inject.
 */
export function buildSystemPromptAppend(
  skillPath: string | null,
  fixIssues: string[],
): string {
  const blocks: string[] = [];

  // 1. Pipeline Discipline guard (not for 03-work or unrecognized stages)
  const stageKey = skillPath ? extractStageKey(skillPath) : null;
  if (stageKey && isValidStageKey(stageKey) && stageKey !== "03-work") {
    blocks.push(
      "\n\n---\n## ⛔ Pipeline Discipline: No Implementation\n\n" +
      "You are entering stage " + stageKey + ". You must NEVER write, edit, modify, " +
      "or delete any source code files. Do not jump to implementation. " +
      "Stay strictly within the scope of this stage. Implementation " +
      "belongs exclusively to the 03-work stage and may only happen there."
    );
  }

  // 2. Skill-reading instruction (for any non-empty skill path)
  if (skillPath) {
    blocks.push(
      "\n\n---\n## Pipeline Stage: Skill Instructions\n\n" +
      "You are entering a new pipeline stage. You MUST immediately read the following " +
      "skill file using the read tool to understand this stage's purpose, rules, and " +
      "expectations:\n\n" + skillPath +
      "\n\nAfter reading the skill, follow its instructions precisely."
    );
  }

  // 3. Domain-specific fetch block (gated on channel + stage)
  if (fixIssues.length > 0 && stageKey === "01-brainstorm") {
    const issueList = fixIssues.map(n => "#" + n).join(", ");
    blocks.push("...");  // see full template in brainstorm requirements artifact
  }

  return blocks.join("");
}
```

**Key rules:**
- **Deterministic order**: guard → instruction → data-fetch
- **Independent gating per block**: each block checks its specific condition
- **Pure function**: no side effects, no module state, fully testable
- **Empty string output** when nothing to inject — drives the handler contract below

## 3. `extractStageKey` — cross-platform SKILL.md path regex

Use a regex that handles both POSIX and Windows separators by matching `[^/\\]+` before `/SKILL.md`:

```typescript
export function extractStageKey(skillPath: string): string | null {
  const match = skillPath.match(/([^/\\]+)[/\\]SKILL\.md$/);
  return match ? match[1] : null;
}
```

**Tested fixtures:**
- `"prefix/SKILL.md.bak"` → null (no `/\\/` before `SKILL.md`)
- `"prefix/SKILL.md/SKILL.md"` → `"SKILL.md"` (last segment)
- `"/skills/01-brainstorm/SKILL.md"` → `"01-brainstorm"` (POSIX)
- `"C:\\skills\\01-brainstorm\\SKILL.md"` → `"01-brainstorm"` (Windows)
- `"/skills/01-brainstorm\\SKILL.md"` → `"01-brainstorm"` (mixed separators)
- `""` → null
- `"no-skill-suffix"` → null

## 4. Handler return contract — `undefined` vs `{ systemPrompt }`

The `before_agent_start` handler must distinguish between "no injection needed" and "injection appended":

```typescript
pi.on("before_agent_start", async (event) => {
  // ... state consumption ...

  const skillPath = getAndClearPendingSkillPath();
  const fixIssues = getAndClearPendingFixIssues();

  const append = buildSystemPromptAppend(skillPath, fixIssues);
  if (!append) return undefined;   // ✅ preserves event-handler chaining

  return {
    systemPrompt: event.systemPrompt + append,  // ✅ injection appended
  };
});
```

**Critical: Return `undefined` (not `{ systemPrompt: event.systemPrompt }`) when no injection is needed.** Per the `@earendil-works/pi-coding-agent` type definitions (`types.d.ts` L735-738), returning `{ systemPrompt: event.systemPrompt }` is a no-op that still counts as "modified" — it breaks event-handler chaining across multiple extensions.

**Gate on append-result, not input conditions:**
```typescript
// ✅ CORRECT
const append = buildSystemPromptAppend(skillPath, fixIssues);
if (!append) return undefined;

// ❌ WRONG — false positive when skillPath is null but fixIssues non-empty producing ""
if (!skillPath && fixIssues.length === 0) return undefined;
```

## 5. Pipeline Discipline Guard

When a pending skill path is detected for a valid pipeline stage (except `03-work`), inject a strict enforcement block:

```
⛔ Pipeline Discipline: No Implementation

You are entering stage <STAGE_KEY>. You must NEVER write, edit, modify, 
or delete any source code files. Do not jump to implementation. 
Stay strictly within the scope of this stage. Implementation 
belongs exclusively to the 03-work stage and may only happen there.
```

**Gate logic:** The guard fires only for valid stage keys (e.g., `02-plan`, `04-review`, `05-learn`) that are not `03-work`. Unrecognized paths produce `null` stage key → guard skipped. The `03-work` exemption is intentional: when the target stage IS work, implementation is expected.

**Pin the exact text in test assertions** — changing the guard text is a breaking change since downstream tests match against it.

## 6. Test file splitting at scale

When a test file exceeds the 800-line project limit (per `AGENTS.md` Code Style), split into domain-specific files rather than accumulating:

| Test File | Contents | Approximate Lines |
|---|---|---|
| `pedstack-commands.test.ts` | Session-traversal helpers, `parseModelRef`, `resolveNextPipelineStage`, `cmdPedStart`, `cmdPedNext` | ~774 |
| `ped-fix-issues.test.ts` | Pending state, `extractStageKey`, `buildSystemPromptAppend`, `parseIssueNumbers`, `cmdPedFixIssues`, `before_agent_start` handler, public exports | ~645 |
| `ce-core-extension-tools.test.ts` | Artifact paths, slug, `artifact_helper`, `workflow_state`, `review_router`, `session_checkpoint` | ~670 |
| `ce-core-extension-tools-2.test.ts` | `task_splitter`, `brainstorm_dialog`, `plan_diff`, `session_history`, `pattern_extractor` | ~650 |
| `ce-core-extension-runtime.test.ts` | Runtime registration, `multi_reviewer` | ~456 |

**Key rules:**
- **Shared mock setup** (~50 lines) is duplicated per file — acceptable tradeoff vs importing from a shared module
- **Non-overlapping `describe` blocks** prevent merge conflicts during parallel development
- **255+ tests across 10 files** can still pass in a single `bun test` run

## 7. Inline notification pattern

Use `ctx.hasUI` guard + direct `ctx.ui.notify()` with typed literal strings — do NOT wrap in a helper:

```typescript
// ✅ CORRECT
if (ctx.hasUI) {
  ctx.ui.notify(
    "Truncated to 10 issues (11 provided).",
    "warning",
  );
}

// ❌ WRONG — type bypass, inconsistency within file
const notifyUI = (msg: string, level: string) => {
  if (ctx.hasUI) ctx.ui.notify(msg, level as any);
};
```

# Why this works

- **Pure function composition** makes each injection block independently testable — no need to mock `pi` or `ctx` for unit tests of `buildSystemPromptAppend`
- **Asymmetric absent-markers** are self-documenting: `null` = "not set", `[]` = "nothing to process"
- **Defensive copies** prevent test-state leak when tests mutate arrays after `setPending*`
- **`undefined` return contract** is the API's documented behavior — following it preserves extension interoperability
- **Cross-platform regex** avoids hard-to-debug failures when running on Windows
- **Test file splitting** enforces the 800-line limit without sacrificing coverage
- **Inline notification** keeps type safety and avoids introducing per-file inconsistencies

# Prevention

- Always use a pure function for system prompt composition — never concatenate at the handler call site
- Add new injection channels as separate module-level variables with symmetric `set`/`getAndClear` accessors
- Gate the handler return on `const append = ...; if (!append) return undefined;`
- Pin verbatim template text in test assertions (guard, skill-reading, fetch blocks)
- When adding tests, check file line count first — split before it exceeds 800 lines
- Use `ctx.hasUI` guard + `ctx.ui.notify()` with typed literal strings directly
- Add both `resetPedstackState()` in test `afterEach` to prevent cross-test state leak

## Downstream Impact

### For 02-plan

When planning new `before_agent_start` injection features or adding new pending state channels, read this card and use `buildSystemPromptAppend` as the composition function (not string concatenation in the handler). Add new blocks with their own gating conditions. Plan test file locations proactively if existing files are near 800 lines.

### For 04-review

When reviewing PRs touching `before_agent_start` handlers:
- Flag any handler that returns `{ systemPrompt: event.systemPrompt }` instead of `undefined` when no injection is needed
- Flag any notification helper that casts `level as any` — prefer inline `ctx.ui.notify()` with typed literals
- Flag test files approaching or exceeding 800 lines — require a split
- Verify new pending state channels follow the `set`/`getAndClear` pattern with `resetPedstackState()` coverage

## Provenance

- **Source plan:** `docs/plans/2026-06-14-ped-fix-issues-command-plan.md`
- **Source brainstorm:** `docs/brainstorms/2026-06-14-ped-fix-issues-command-requirements.md`
- **Source review:** `docs/reviews/2026-06-14-ped-fix-issues-command.md`
- **Related solution:** `docs/solutions/workflow/replacing-implicit-input-interception-with-explicit-commands.md`
- **API type verification:** `@earendil-works/pi-coding-agent` at `dist/core/extensions/types.d.ts` L468-472 (before_agent_start event), L735-738 (result contract)

---

## 🧠 Context Status

- **Health:** good
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  1. `extensions/ce-core/commands/pedstack.ts`
  2. `extensions/ce-core/commands/prompt-inject.ts`
  3. `extensions/ce-core/index.ts`
  4. `tests/ped-fix-issues.test.ts`
  5. `tests/pedstack-commands.test.ts`
- **Next stage:** `06-docsync` — recommend syncing documentation
