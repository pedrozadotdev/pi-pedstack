---
title: Tool-Based Task Tracking with Handoff Gating via Checklist Tools
category: workflow
severity: medium
tags:
  - pi-extension
  - checklist
  - task-tracking
  - handoff-gating
  - state-file
  - tool-registration
  - factory-pattern
  - instructional-directive
  - output-augmentation
  - read-output-filter
  - system-prompt-injection
  - pipeline-discipline
  - pedstack
  - cross-module-state
  - complexity-reduction
applies_when:
  - Implementing persistent task-tracking tools in a pi extension
  - Gating cross-stage handoffs on task completion
  - Augmenting read tool output with instructional directives for .md files
  - Detecting instructional files (SKILL.md, rules/*.md, references/*.md)
  - Sharing state between tools and pipeline infrastructure modules
  - Reducing cyclomatic complexity in large filter/switch functions
  - Using try/finally guards for process.chdir in tests
---

# Problem

Pi extensions that orchestrate workflow pipelines need a way for the AI model to track tasks discovered from instructional documents, rules, and skills. Without persistent task tracking:

1. **Forgetfulness**: The model reads a SKILL.md, discovers tasks it must perform, then forgets them as context shifts to file edits and tool calls.
2. **Unsafe handoffs**: The model saves a cross-stage handoff with unresolved tasks, forcing the next stage to rediscover work that should have been completed.
3. **No task awareness in system prompt**: The model has no built-in discipline to use task tracking — it must be explicitly reminded via system prompt injection.
4. **Invisible task discovery**: When reading SKILL.md or rules files, the model must independently decide to track discovered tasks. There is no nudge in the tool output.

The Checklist Tools feature solves all four problems with a composable set of tools, hooks, and prompt injections.

*Related solution:* [System Prompt Injection via before_agent_start](./before-agent-start-pending-state-injection.md) documents the `buildSystemPromptAppend` mechanism that the checklist discipline block extends.

# Context

This pattern was developed and refined during the `pi-pedstack` ce-core extension's Checklist Tools feature (see [source brainstorm](../../docs/brainstorms/2026-06-19-checklist-tools-requirements.md), [source plan](../../docs/plans/2026-06-19-checklist-tools-plan.md), [source review](../../docs/reviews/2026-06-19-checklist-tools.md)). The feature spanned 6 implementation units, 40+ tests, and a full 04-review → 04-5-debug cycle that surfaced 11 review findings, 3 of which were autofixed.

The pipeline constraints that drove the design:

- Verify all stages pass (`bun test` must stay green)
- Keep functions < 50 lines and files < 800 lines (per `AGENTS.md`)
- No `console.log` in production code
- Strict TypeScript with explicit error handling

# Solution

## 1. State-backed CRUD tools with shared helpers

### 1.1 Types and state file helpers (exported for cross-module use)

```typescript
export interface ChecklistItem {
  description: string;
  addedAt: string;
}

export interface ChecklistData {
  items: ChecklistItem[];
}

export async function readChecklist(cwd?: string): Promise<ChecklistData> {
  const filePath = path.join(cwd ?? process.cwd(), ".context", "checklist.json");
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as ChecklistData;
  } catch {
    return { items: [] };  // corrupt or missing → treat as empty
  }
}
```

**Key patterns:**

- **Corrupt file resilience**: `JSON.parse` failure returns `{ items: [] }` instead of crashing
- **Exported types and reader**: `readChecklist` and `ChecklistData`/`ChecklistItem` are exported so `context-handoff.ts` can consume state without duplicating file I/O logic
- **CWD parameter**: optional `cwd` allows context-handoff to pass `repoRoot` while tools default to `process.cwd()`

### 1.2 Factory pattern for tool creation

Each tool follows the `createXxxTool()` factory pattern returning `{ name, async execute(input) }`. The three tools (`checklist_add`, `checklist_show`, `checklist_del`) share state via the `readChecklist`/`writeChecklist` helpers.

**`checklist_del` — dedup + reverse-order removal:**

```typescript
const uniqueDesc = [...new Set(input.indexes)]
  .filter((n) => Number.isInteger(n))
  .sort((a, b) => b - a);

for (const idx of uniqueDesc) {
  if (idx >= 1 && idx <= data.items.length) {
    data.items.splice(idx - 1, 1);
    removed.push(idx);
  } else {
    skipped.push(idx);
  }
}
removed.sort((a, b) => a - b);
```

**Key patterns:**

- **Deduplication**: `new Set(input.indexes)` handles `[1, 1, 2]` → `[1, 2]`
- **Reverse-order removal**: Sorting descending before `splice` maintains index stability
- **Return both removed and skipped**: The model can see which indexes were invalid

## 2. Handoff gating via cross-module state consumption

### 2.1 Block cross-stage saves when checklist is non-empty

In `context-handoff.ts`:

```typescript
import { readChecklist } from "./checklist";

// In save():
if (nextStage) {
  try {
    const checklist = await readChecklist(input.repoRoot);
    if (checklist.items.length > 0) {
      return {
        operation: "save",
        found: true,
        // ... other fields ...
        blocker:
          "Cannot save cross-stage handoff: checklist has " +
          checklist.items.length + " pending task(s).\n\n" +
          "Pending tasks:\n" + taskList +
          "\n\nUse \\`checklist_del\\` to remove completed tasks before saving.",
      };
    }
  } catch {
    // If readChecklist throws, allow save to proceed safely
  }
}
```

**Key patterns:**

- **Cross-stage only**: `if (nextStage)` — same-stage saves (checkpoints) are always allowed
- **Safe fallthrough**: `try/catch` around `readChecklist` — if file is corrupt, save proceeds
- **Descriptive error**: Lists pending tasks so the model knows exactly what to delete

### 2.2 Validation probe reports checklist status

```typescript
// In validate():
let checklistNonEmpty = false;
try {
  const checklist = await readChecklist(input.repoRoot);
  checklistNonEmpty = checklist.items.length > 0;
  if (checklistNonEmpty) {
    warnings.push("checklist: " + checklist.items.length +
      " pending task(s) — " + summary);
  }
} catch { /* skip probe */ }

checks.push({
  name: "checklist_empty",
  passed: !checklistNonEmpty,
  reason: checklistNonEmpty
    ? "Checklist has pending tasks"
    : "Checklist is empty or absent",
});

const ok = recallPass && continuationPass && !checklistNonEmpty;  // affects ok
```

**Key patterns:**

- **`ok` derivation includes checklist**: `!checklistNonEmpty` affects the overall validation result — a non-empty checklist makes validate fail
- **Warning + check**: Both a human-readable warning and a structured check entry

## 3. Instructional file detection + output augmentation

### 3.1 `isInstructionalFile` helper

```typescript
function isInstructionalFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    /SKILL\.md$/.test(normalized) ||
    /(?:^|\/)rules\/.*\.md$/i.test(normalized) ||
    /(?:^|\/)references\/.*\.md$/i.test(normalized)
  );
}
```

**Key pattern:**

- **Path normalization**: Replace backslashes before testing — supports both POSIX and Windows paths
- **Specific patterns**: Only SKILL.md (exact match), `rules/*.md`, and `references/*.md` — NOT README.md, CHANGELOG.md, or general docs
- **Case-insensitive for rule/reference directories**: `/(?:^|\/)rules\/.*\.md$/i` — the `/i` flag handles `Rules/` or `RULES/`

### 3.2 `applyInstructionalDirective` helper (extracted from 6+ duplicate branches)

```typescript
function buildDirective(): string {
  return "\n\n⚠️ REQUIREMENT: After reading these instructions, use " +
    "`checklist_add` to add any new tasks this document instructs you to perform. " +
    "Manage pending tasks with `checklist_show` and `checklist_del`.";
}

function applyInstructionalDirective(
  output: string,
  originalBytes: number,
): ReadOutputFilterResult {
  const directive = buildDirective();
  const withDirective = output + directive;
  return {
    output: withDirective,
    filtered: true,
    originalBytes,
    filteredBytes: Buffer.byteLength(withDirective, "utf-8"),
    strategy: "instructional-directive",
  };
}
```

### 3.3 Critical ordering: instructional check BEFORE early return

```typescript
export function filterReadOutput(input: ReadOutputFilterInput): ReadOutputFilterResult {
  const { path, output, isError, isImage } = input;
  const originalBytes = Buffer.byteLength(output, "utf-8");

  // Don't filter images or errors
  if (isImage || isError) { /* ... */ }

  const instructional = isInstructionalFile(path);  // ✅ CHECK FIRST

  // Small outputs: only filter if instructional
  if (originalBytes < MIN_FILTER_THRESHOLD) {
    return instructional
      ? applyInstructionalDirective(output, originalBytes)
      : { /* not filtered */ };
  }

  // ... category filtering ...
  // Every return branch checks `instructional` before deciding
}
```

**🔥 CRITICAL:** The `isInstructionalFile` check must happen BEFORE the small-file threshold early return. If the early return fires first, a small instructional file never gets its directive appended.

## 4. System prompt checklist discipline injection

Added as a new block in `buildSystemPromptAppend`:

```typescript
// 3.5 Checklist discipline (for all valid pipeline stages)
if (stageKey && isValidStageKey(stageKey)) {
  blocks.push(
    "\n\n---\n## ✅ Checklist Discipline\n\n" +
    "Use `checklist_add` to add tasks discovered from skills, rules, and instructions.\n" +
    "Use `checklist_show` to review pending tasks.\n" +
    "Use `checklist_del` to remove completed tasks.\n" +
    "Before saving a cross-stage handoff via `context_handoff save`, ensure the " +
    "checklist is empty by completing or deleting all pending tasks.",
  );
}
```

**Key patterns:**

- **Gated on valid stage keys**: Only injected when a pipeline skill is loading — not on every agent start
- **Third-party block in composition order**: Block #3.5 in the ordered composition (after skill-reading at #3, before fix-issues at #4)
- **Imperative tone**: Uses "Use X", "Ensure Y" — not "Consider" or "You may"

## 5. Code quality patterns discovered during review

### 5.1 Helper extraction from duplicated branches (Finding #2 → Autofix)

The `applyInstructionalDirective` helper was extracted after the review found it duplicated across 6+ branches of `filterReadOutput`. Every branch that returned filtered/unfiltered output had an identical 7-line block checking `if (instructional) { ... }`.

**Before:** 6+ copies of:

```typescript
if (instructional) {
  const directive = buildDirective();
  return {
    output: output + directive,
    filtered: true,
    originalBytes,
    filteredBytes: Buffer.byteLength(output + directive, "utf-8"),
    strategy: "instructional-directive",
  };
}
```

**After:** One `applyInstructionalDirective(output, originalBytes)` call.

### 5.2 `filterByCategory` complexity reduction (Finding #4 → Autofix)

`filterReadOutput` had cyclomatic complexity 24 — well above the project guideline. Extracting per-category filtering into a `filterByCategory` helper reduced the main function's complexity below 10.

```typescript
interface CategoryFilterResult {
  filtered: string | null;
  strategyName: string;
  fallbackStrategy: string;
}

function filterByCategory(
  category: FileCategory,
  output: string,
  path: string,
  originalBytes: number,
): CategoryFilterResult | null {
  switch (category) {
    case "lock-file": return { filtered: filterLockFile(output, path), ... };
    case "package-json": return { filtered: filterPackageJson(output, path), ... };
    case "code": return { filtered: filterCode(output, path, originalBytes), ... };
    // ... each case is a focused, testable function
  }
}
```

### 5.3 `try/finally` guard for `process.chdir()` in tests (Finding #8 → Autofix)

When tests change the working directory to test CWD-based state resolution, wrap the chdir in `try/finally`:

```typescript
process.chdir(repoRoot);
try {
  await addTool.execute({ description: "Task X" });
  // assertions
} finally {
  process.chdir(origCwd);  // restore even if assertions fail
}
```

Bun's test isolation may mitigate a leak, but `try/finally` is defensive regardless.

# Why this works

1. **State-backed tools provide persistence across turns**: The checklist survives context compression because it's stored in `.context/checklist.json`, not in the model's context window.
2. **Cross-module state avoids duplication**: Exporting `readChecklist` from `checklist.ts` means `context-handoff.ts` reads the same source of truth — no stale copies, no duplicate file-parsing logic.
3. **Handoff gating is explicit and actionable**: When the model tries to save a cross-stage handoff with pending tasks, the error lists each task. The model knows exactly what to delete.
4. **Instructional directive is unavoidable**: Because it's appended to the read tool output at the source (via the `tool_result` filter hook), the model sees it every time it reads a SKILL.md, rules file, or references file.
5. **System prompt discipline creates habit**: The ✅ Checklist Discipline block reminds the model of the tools before it starts working. The read tool directive reinforces it when tasks are discovered.
6. **Code quality patterns scale**: `applyInstructionalDirective` and `filterByCategory` are reusable patterns that prevent complexity from accumulating in filter functions.

# Prevention

- **Always export `readChecklist` (or equivalent) from the state module** — let consumers import the reader rather than duplicating file I/O.
- **Gate handoff blocking on `nextStage` presence only** — same-stage saves (checkpoints) must never be blocked by pending tasks.
- **Include `!checklistNonEmpty` in the `validate` `ok` derivation** — a non-empty checklist should make validation fail, not just produce a warning.
- **Check `isInstructionalFile` BEFORE the small-file early return** — otherwise small instructional files silently lose their directive.
- **Extract duplicated logic into helpers before the review finds it** — `applyInstructionalDirective` was a simple extraction that eliminated 6+ copies.
- **Use `try/finally` for `process.chdir()` in tests** — never assume the test assertion will succeed.
- **Add tests for state file corruption** — `readChecklist()` must return empty data for invalid JSON, not crash.
- **Add tests for `isInstructionalFile` directly** — test SKILL.md, rules/foo.md, references/bar.md, README.md (no match), CHANGELOG.md (no match), backslash paths.

## Test infrastructure patterns

| Pattern | Test count | File |
|---------|-----------|------|
| `checklist_add` / `checklist_show` / `checklist_del` | ~15 | `tests/checklist.test.ts` |
| Cross-stage handoff block with non-empty checklist | 2 | `tests/context-handoff.test.ts` |
| Same-stage handoff allowed with non-empty checklist | 1 | `tests/context-handoff.test.ts` |
| `isInstructionalFile` path detection | 6 | `tests/read-output-filter.test.ts` |
| Directive appended to instructional files | 4 | `tests/read-output-filter.test.ts` |
| No directive for non-instructional .md files | 2 | `tests/read-output-filter.test.ts` |
| Checklist discipline block in buildSystemPromptAppend | 3 | `tests/ped-fix-issues.test.ts` |

## Downstream Impact

### For 02-plan

When planning new tools that manage persistent state:

- Plan the `export async function readXxx()` + export types pattern from the start — cross-module consumers will need it
- Plan for corrupt-file resilience (try/catch on JSON.parse)
- Plan tool registration in `index.ts` with TypeBox schemas following the existing pattern
- Plan test file location — isolate new tool tests in their own file (e.g., `checklist.test.ts`) to stay under 800 lines

### For 04-review

When reviewing PRs touching state-backed tools or output filters:

- Flag any tool that re-reads its own state file — verify it imports the exported reader
- Flag any `context_handoff save` return that doesn't check checklist status (if the feature is present)
- Flag any early return before `isInstructionalFile` is checked in read output filters
- Flag any `process.chdir()` without `try/finally` in tests
- Flag any duplicated logic blocks that could be extracted into a shared helper
- Flag `filterReadOutput`-like functions with cyclomatic complexity > 15 — require extraction
- Verify `ok` derivation in `validate()` includes `!checklistNonEmpty` (or equivalent gate)

## Provenance

- **Source brainstorm:** `docs/brainstorms/2026-06-19-checklist-tools-requirements.md`
- **Source plan:** `docs/plans/2026-06-19-checklist-tools-plan.md`
- **Source review:** `docs/reviews/2026-06-19-checklist-tools.md`
- **Related solution:** `docs/solutions/workflow/before-agent-start-pending-state-injection.md` (system prompt injection mechanism)
- **Related solution:** `docs/solutions/workflow/replacing-implicit-input-interception-with-explicit-commands.md` (command factory pattern)
- **Source files:**
  - `extensions/ce-core/tools/checklist.ts` — State-backed tools + shared helpers
  - `extensions/ce-core/tools/context-handoff.ts` — Handoff gating + validation probes
  - `extensions/ce-core/tools/read-output-filter.ts` — Instructional file detection + directive
  - `extensions/ce-core/commands/prompt-inject.ts` — System prompt checklist discipline
  - `extensions/ce-core/index.ts` — Tool registration
  - `tests/checklist.test.ts`, `tests/context-handoff.test.ts`, `tests/read-output-filter.test.ts`, `tests/ped-fix-issues.test.ts`

---

## 🧠 Context Status

- **Health:** good
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  1. `extensions/ce-core/tools/checklist.ts`
  2. `extensions/ce-core/tools/context-handoff.ts`
  3. `extensions/ce-core/tools/read-output-filter.ts`
  4. `extensions/ce-core/commands/prompt-inject.ts`
  5. `extensions/ce-core/index.ts`
- **Next stage:** `06-docsync` — recommend syncing documentation
