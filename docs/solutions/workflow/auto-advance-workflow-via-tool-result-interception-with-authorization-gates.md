---
title: Auto-Advance Workflow via tool_result Interception with Authorization Gates
category: workflow
severity: medium
tags:
  - pi-extension
  - tool-result
  - auto-advance
  - pipeline-automation
  - sendUserMessage
  - followUp
  - confirm-dialog
  - authorization-cache
  - gated-transition
  - ponytail
  - complexity-reduction
  - pure-function
  - discriminated-union
  - pedstack
  - tool_result-handler
  - additive-handler
  - error-isolation
applies_when:
  - Creating a pi extension that needs to auto-queue commands after specific tool calls
  - Implementing pipeline automation with user authorization gates
  - Using `pi.on("tool_result")` for additive behavior without breaking existing handlers
  - Reducing manual command invocations in a multi-stage workflow pipeline
  - Building a pure-function decision engine with discriminated-union verdict types
  - Managing per-session authorization caches with in-memory Sets
---

# Problem

Multi-stage workflow pipelines in pi extensions often require the user to manually invoke a command (e.g., `/ped-next`) after every stage completes. This creates unnecessary friction for transitions that are purely mechanical, while still needing user approval for critical decisions (e.g., "read the plan first before implementing").

The challenge is threefold:

1. **Detection**: How does the extension know *when* a stage completes? The canonical signal — `context_handoff save` — is a tool call, not a user message or agent-end event.
2. **Gated decisions**: Two of six transitions need a user authorization dialog, but the other four should auto-advance silently. The gating logic must be testable and side-effect-free.
3. **Failure isolation**: The automation must never break the handoff save itself. A bug in the auto-advance logic should not prevent the stage from completing.

# Context

This pattern was discovered during the `pi-pedstack` ce-core extension's auto-advance workflow feature (see [source brainstorm](../../docs/brainstorms/2026-06-29-auto-advance-workflow.md), [source plan](../../docs/plans/2026-06-29-auto-advance-workflow.md), [source review](../../docs/reviews/2026-06-29-auto-advance-workflow.md)). The pipeline had six stages (`01-brainstorm` → `02-plan` → `03-work` → `04-review` → `05-learn` → `06-docsync`) and required the user to type `/ped-next` between every stage — five manual invocations per full pipeline run.

The project already had established patterns for:

- **`pi.registerCommand()`** for explicit slash commands (see [replacing-implicit-input-interception-with-explicit-commands.md](./replacing-implicit-input-interception-with-explicit-commands.md))
- **`pi.on("before_agent_start")`** for system prompt injection (see [before-agent-start-pending-state-injection.md](./before-agent-start-pending-state-injection.md))
- **`pi.on("tool_result")`** for read-output filtering and instructional directives (see [tool-based-task-tracking-with-handoff-gating.md](./tool-based-task-tracking-with-handoff-gating.md))

The auto-advance feature adds a **third** `tool_result` handler (parallel to the bash and read filters) that only triggers on `context_handoff` tool results, using `pi.sendUserMessage` with `deliverAs: "followUp"` to queue `/ped-next` automatically.

## Pipeline constraints

- All functions must stay under 50 lines, files under 800 lines (per `AGENTS.md`)
- TypeScript strict mode with explicit error handling
- No new dependencies — `node:*` modules and the pi extension API only
- All existing tests must pass (359 tests, 0 failures)
- Fallow audit: no critical complexity, no dead code, no circular dependencies

# Solution

## 1. Pure verdict function with discriminated union

The heart of the solution is a pure function that takes a `tool_result` event's relevant fields and returns a verdict type. This keeps the decision logic testable in isolation — no mocks needed for the core logic.

```typescript
type AutoAdvanceAction =
  | { action: "none" }
  | { action: "send"; message: string }
  | { action: "confirm"; title: string; message: string };

interface AutoAdvanceInput {
  toolName: string;
  input: { operation?: string } | null | undefined;
  contentText: string | null;
  isError: boolean;
  hasUI: boolean;
  isAuthorized: boolean;
}
```

The function uses linear early-returns (12+ guard conditions) that map directly to the failure mode registry:

```typescript
export function evaluateAutoAdvance(input: AutoAdvanceInput): AutoAdvanceAction {
  if (input.toolName !== "context_handoff") return { action: "none" };
  if (!input.input || input.input.operation !== "save") return { action: "none" };
  if (input.isError) return { action: "none" };
  if (!input.contentText) return { action: "none" };

  const parsed = tryParseHandoffResult(input.contentText);
  if (!parsed) return { action: "none" };

  const stages = getHandoffStagePair(parsed);
  if (!stages) return { action: "none" };

  const stagePair = `${stages.currentStage}->${stages.nextStage}`;

  if (shouldShowConfirm(stagePair, input.hasUI, input.isAuthorized)) {
    return { action: "confirm", title: "...", message: "..." };
  }

  return { action: "send", message: "/ped-next" };
}
```

**Key patterns:**

- **Pure function**: No side effects, no I/O, no imports beyond the input interface — fully testable with simple object inputs
- **Discriminated union return type**: `"none"` | `"send"` | `"confirm"` — the caller pattern-matches on `verdict.action` to dispatch
- **Linear early-returns**: Each guard addresses exactly one row of the failure mode registry; the final line is the happy path
- **Extracted helpers**: `tryParseHandoffResult`, `getHandoffStagePair`, `isGatedTransition`, `shouldShowConfirm` — each < 10 lines, pure, testable

## 2. Gated transitions set with confirm dialog mapping

Define gated transitions as a `Set<string>` of stage-pair keys, with a parallel `Record` for dialog content:

```typescript
const GATED_TRANSITIONS = new Set<string>([
  "02-plan->03-work",
  "04-review->05-learn",
]);

const CONFIRM_DIALOGS: Record<string, { title: string; message: string }> = {
  "02-plan->03-work": {
    title: "Continue to 03-work?",
    message: "The plan is complete. Proceed to implementation (03-work), " +
      "or use /ped-reload to re-plan?",
  },
  "04-review->05-learn": {
    title: "Continue to 05-learn?",
    message: "Code review complete. Proceed to learn (05-learn), " +
      "or use /ped-debug if bugs were found.",
  },
};
```

**Key patterns:**

- **Stage-pair key format**: `"currentStage->nextStage"` — human-readable and consistent with handoff output
- **Separate dialog map**: Avoids stuffing UI strings into the transitions set; each pair has its own title and message
- **Hard-coded set (`ponytail:)`**: Intentionally not configurable — YAGNI for dynamic gated pairs

## 3. Per-session authorization cache with in-memory Set

Once a user approves a gated transition, remember the decision for the rest of the session to avoid re-prompting:

```typescript
// ponytail: In-memory Set for the authorization cache. Per-session only;
// cross-session persistence is YAGNI for now.
const authorizedPairs = new Set<string>();

export function markAuthorized(stagePair: string): void {
  authorizedPairs.add(stagePair);
}

export function isAuthorized(stagePair: string): boolean {
  return authorizedPairs.has(stagePair);
}

export function clearAutoAdvanceCache(): void {
  authorizedPairs.clear();
}
```

**Key patterns:**

- **Module-level `Set<string>`**: Simple, no persistence, no dependencies — cleared on session restart
- **Exported API**: `markAuthorized`, `isAuthorized`, `clearAutoAdvanceCache` — tests can clear between cases
- **`ponytail:` comment**: Explicitly marks the intentional shortcut for reviewers

## 4. `tool_result` handler with content extraction + dispatch separation

The handler in `index.ts` has three responsibilities, split into two helpers to stay under 50 lines:

**`extractSaveContent(event)`** — parses the raw tool_result event into structured data:

```typescript
function extractSaveContent(
  event: any,
): { contentText: string; stagePair: string | null } | null {
  const input = event.input as { operation?: string } | null;
  if (input?.operation !== "save") return null;

  const textBlocks =
    (event.content as Array<any>)?.filter((b: any) => b.type === "text") ?? [];
  if (textBlocks.length === 0) return null;
  const contentText = textBlocks.map((b: any) => b.text).join("");

  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(contentText); } catch { return null; }

  const stagePair = parsed?.currentStage && parsed?.nextStage
    ? `${String(parsed.currentStage)}->${String(parsed.nextStage)}`
    : null;

  return { contentText, stagePair };
}
```

**`dispatchAutoAdvanceVerdict(verdict, stagePair, hasUI, confirmFn)`** — executes the verdict:

```typescript
async function dispatchAutoAdvanceVerdict(
  verdict: AutoAdvanceAction,
  stagePair: string | null,
  hasUI: boolean,
  confirmFn: (title: string, message: string) => Promise<boolean>,
): Promise<void> {
  if (verdict.action === "send") {
    pi.sendUserMessage(verdict.message, { deliverAs: "followUp" });
    if (stagePair) markAuthorized(stagePair);
    return;
  }

  if (verdict.action === "confirm") {
    if (hasUI) {
      const ok = await confirmFn(verdict.title, verdict.message);
      if (ok) {
        pi.sendUserMessage("/ped-next", { deliverAs: "followUp" });
        if (stagePair) markAuthorized(stagePair);
      }
    } else {
      // ponytail: Print mode — no dialog, auto-advance silently
      pi.sendUserMessage("/ped-next", { deliverAs: "followUp" });
      if (stagePair) markAuthorized(stagePair);
    }
  }
}
```

The handler itself is then lean — ~30 lines:

```typescript
pi.on("tool_result", async (event, ctx) => {
  if (event.toolName !== "context_handoff") return undefined;

  try {
    const saveContent = extractSaveContent(event);
    if (!saveContent) return undefined;

    const verdict = evaluateAutoAdvance({
      toolName: event.toolName,
      input: event.input as { operation?: string } | null,
      contentText: saveContent.contentText,
      isError: event.isError ?? false,
      hasUI: ctx.hasUI,
      isAuthorized: saveContent.stagePair
        ? isAuthorized(saveContent.stagePair)
        : false,
    });

    await dispatchAutoAdvanceVerdict(
      verdict, saveContent.stagePair, ctx.hasUI,
      (t, m) => ctx.ui.confirm(t, m),
    );
  } catch (err) {
    // ponytail: never let auto-advance bugs break the handoff save
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Auto-advance failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }
  return undefined;
});
```

**Key patterns:**

- **Early return on non-target tool**: `if (event.toolName !== "context_handoff") return undefined;` — preserves handler chaining
- **Content extraction separates I/O from decision**: `extractSaveContent` handles the raw event parsing; `evaluateAutoAdvance` is pure
- **Dispatch function takes a `confirmFn` callback**: Makes it testable without actual `ctx.ui` (inject a mock)
- **Error isolation with catch-all + notify**: Every error is caught, surfaced as a notification, and does **not** re-throw — respecting the "never break the handoff save" principle
- **`return undefined`**: Preserves event-handler chaining for other extensions

## 5. Failure mode registry → test coverage map

Every possible failure mode is documented with its rescue strategy and test coverage:

| Codepath | Failure mode | Rescue | Test? |
|----------|-------------|--------|-------|
| `evaluateAutoAdvance` | Non-pedstack tool name | Return `none` | ✅ |
| `evaluateAutoAdvance` | Non-save operation | Return `none` | ✅ |
| `evaluateAutoAdvance` | `isError=true` | Return `none` | ✅ |
| `evaluateAutoAdvance` | Blocker present | Return `none` | ✅ |
| `evaluateAutoAdvance` | Same-stage save | Return `none` | ✅ |
| `evaluateAutoAdvance` | Unknown stage pair | Return `send` | ✅ |
| `evaluateAutoAdvance` | Malformed JSON | Return `none` | ✅ |
| `evaluateAutoAdvance` | Missing currentStage/nextStage | Return `none` | ✅ |
| Index handler | `sendUserMessage` throws | Notify, no re-throw | ✅ |
| Index handler | Confirm reject/cancel | Silent no-op | ✅ |
| Index handler | `!hasUI` on gated pair | Auto-advance silently | ✅ |
| Authorization cache | Re-save of same gated pair | Cache hit → auto-advance | ✅ |

**Test totals:** 37 pure-module tests + 10 integration tests = 47 tests covering the full matrix. Every failure mode has at least one test.

## 6. Ponytail cuts (YAGNI)

The plan explicitly documented these cuts to keep scope minimal:

| Cut | Rationale |
|-----|-----------|
| **`/ped-auto-advance` command** | `/ped-next` IS the auto-advance command; a synonym adds zero power |
| **`--no-confirm` flag on `/ped-next`** | The cache already remembers user approval for the session |
| **Configurable gated pairs via JSON** | A `Set<string>` literal in source is enough for exactly 2 pairs |
| **Separate auto-advance command factory** | No new `registerCommand` needed — it's handler-only |

## 7. Handler ordering and parallel dispatch

The auto-advance handler is registered as the **third** `tool_result` handler, running in parallel to existing bash and read filters. The extension's registration pattern looks like:

```typescript
// Handler 1: bash output filter
pi.on("tool_result", async (event, _ctx) => { ... });
// Handler 2: read output filter  
pi.on("tool_result", async (event, _ctx) => { ... });
// Handler 3: auto-advance
pi.on("tool_result", async (event, ctx) => { ... });
```

**Key pattern:** All three handlers fire on every tool result. Each one short-circuits early for non-target tools (first handler: non-bash tools; second: non-read tools; third: non-context_handoff tools). This is additive behavior — no handler interferes with another's return value.

# Why this works

## `tool_result` is the right interception point

The `context_handoff save` call is the canonical "stage complete" signal — every pipeline skill calls it at the end of its work. Hooking into `tool_result` for this specific tool name is:

- **Precise**: Only fires when the stage is actually complete (not on errors, not on agent interrupts, not on load/validate operations)
- **Non-invasive**: The tool itself doesn't change — no signature change, no new required field
- **Documented**: The pi extension API docs show `pi.sendUserMessage(..., { deliverAs: "followUp" })` as the canonical pattern for queuing commands from handlers ([reload-runtime example](https://pi.dev/docs/latest/extensions))

## `deliverAs: "followUp"` queues the command after the model's turn

Using `{ deliverAs: "followUp" }` means the `/ped-next` message is queued to be sent after the current model turn finishes — not immediately. This is critical because:

- The model's final output (e.g., "Stage complete, saving handoff...") is displayed first
- The auto-advance fires as the next turn, just as if the user had typed `/ped-next` manually
- No race condition between tool result handling and model response

## Stage-pair key format prevents false matches

The `"currentStage->nextStage"` key format ensures gating is specific to the exact transition. A re-save within the same stage (e.g., `04-review->04-review`) is correctly identified as same-stage and skipped. Unknown stage pairs (e.g., a new stage added later) default to auto-advance (return `send`) rather than blocking.

## Gated transitions auto-advance silently in print mode

When `ctx.hasUI` is false (print/json mode), the handler skips the confirm dialog and auto-advances directly. This means the full pipeline can run in batch/script mode with zero user interaction. The `-p` flag on pi invocations enables print mode.

## Complexity is managed through extraction

The review found cyclomatic complexity at 23 in the initial handler. By extracting `extractSaveContent` and `dispatchAutoAdvanceVerdict`:

- Handler body: 69 → **30 lines**
- Max cyclomatic: 23 → **12**
- Each helper < 50 lines, each with focused responsibility

## Test coverage is exhaustive

The 23+ test scenarios cover every branch, including edge cases like `JSON.parse("null")` (where `typeof null === "object"` is a JavaScript gotcha) and the interaction between `hasUI`, `isAuthorized`, and gated/non-gated transitions.

# Prevention

## For future `tool_result` handlers

1. **Always return `undefined`** — returning a modified result from a `tool_result` handler changes the tool output for downstream handlers and the model. Return `undefined` for additive behavior.

2. **Early-return for non-target tools** — `if (event.toolName !== "my-target") return undefined;` at the top of the handler preserves performance and avoids side effects.

3. **Wrap in try/catch with notification** — never let a handler crash affect the tool result:

   ```typescript
   try { /* handler logic */ }
   catch (err) {
     if (ctx.hasUI) ctx.ui.notify(`Handler failed: ${err}`, "error");
   }
   return undefined;
   ```

4. **Extract content parsing from decision logic** — the `extractSaveContent` / `evaluateAutoAdvance` separation makes the decision engine pure and testable while the content parsing is an I/O concern.

## For gating logic

1. **Use a Set for hard-coded gates** — `new Set<string>(["pair1", "pair2"])` is readable, testable, and trivially extensible
2. **Use a parallel Record for dialog messages** — don't mix UI strings into the gating logic
3. **Stage-pair key format** — `"currentStage->nextStage"` — consistent, debuggable, and self-documenting
4. **Default to auto-advance for unknown pairs** — `return { action: "send" }` at the end of `evaluateAutoAdvance` ensures forward compatibility

## For authorization caches

1. **In-memory `Set<string>` for per-session caches** — simple, testable, no persistence needed
2. **Clear in test `beforeEach` / `afterEach`** — prevents cross-test state leak
3. **`ponytail:` comment to mark intentional simplicity** — signals to reviewers that cross-session persistence was intentionally excluded

## For reducing handler complexity

1. **Set a cyclomatic complexity budget** — if the handler grows beyond 20 cyclomatic, extract helpers before merging
2. **Extract content parsing first** — it's the most branching-heavy part (null handling, JSON parse, field extraction)
3. **Extract dispatch second** — the `send` / `confirm with UI` / `confirm without UI` pattern is a natural extraction boundary
4. **Keep the handler body ≤ 50 lines** — use the extracted helpers to stay under the project limit

## Related learnings

- **[replacing-implicit-input-interception-with-explicit-commands.md](./replacing-implicit-input-interception-with-explicit-commands.md)** — documents the `sendUserMessage` with `deliverAs: "followUp"` pattern that auto-advance uses for queueing commands
- **[before-agent-start-pending-state-injection.md](./before-agent-start-pending-state-injection.md)** — documents the parallel pattern for `pi.on("before_agent_start")` with pure-function composition
- **[tool-based-task-tracking-with-handoff-gating.md](./tool-based-task-tracking-with-handoff-gating.md)** — documents the first `tool_result` handler (read output filter) with identical error-isolation pattern
- **[extracting-optional-pipeline-stages-with-on-demand-command-gating.md](./extracting-optional-pipeline-stages-with-on-demand-command-gating.md)** — documents the command-gating pattern that inspired the staged gating approach

## Provenance

- **Source brainstorm:** `docs/brainstorms/2026-06-29-auto-advance-workflow.md`
- **Source plan:** `docs/plans/2026-06-29-auto-advance-workflow.md`
- **Source review:** `docs/reviews/2026-06-29-auto-advance-workflow.md`
- **Source files:**
  - `extensions/ce-core/utils/auto-advance.ts` — Pure verdict module + authorization cache
  - `extensions/ce-core/index.ts` — `tool_result` handler with `extractSaveContent` + `dispatchAutoAdvanceVerdict`
  - `tests/auto-advance.test.ts` — 37 pure-module tests covering transition matrix + cache API
  - `tests/ce-core-extension-runtime.test.ts` — 10 integration tests for handler wiring
  - `skills/references/pipeline-config.md` — Auto-advance behavior section
- **Branch:** Feature branch for auto-advance workflow (2026-06-29)

## Downstream Impact

### For 02-plan

When planning new pipeline automation features or additional `tool_result` handlers:

1. Read this card to understand the `tool_result` interception pattern and the error-isolation protocol
2. Check `extensions/ce-core/index.ts` for the existing 3-handler ordering — a new handler should short-circuit for non-target tools and return `undefined`
3. Review the failure mode registry in the plan artifact — ensure every new codepath has a test for each failure mode

### For 04-review

When reviewing PRs that touch `extensions/ce-core/index.ts` or add new `pi.on("tool_result")` handlers:

1. **Flag handlers that return a modified `event.content` without `return undefined`** — the existing filter pattern returns filtered content, but additive handlers must return `undefined`
2. **Flag handlers without `try/catch` + notification** — the error-isolation pattern is mandatory for all handlers
3. **Flag handlers that re-throw** — a handler crash must never bubble up
4. **Verify tool count hasn't changed** — if the PR adds a new tool, test the count assertion in `ce-core-extension-runtime.test.ts`
5. **Verify all 6 transitions are tested** — 4 auto, 2 gated, each with `hasUI=true` and `hasUI=false` variants

---

## 🧠 Context Status

- **Health:** good
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  1. `extensions/ce-core/utils/auto-advance.ts` — Pure verdict module
  2. `extensions/ce-core/index.ts` — Handler wiring
  3. `tests/auto-advance.test.ts` — 37 pure-module tests
  4. `tests/ce-core-extension-runtime.test.ts` — 10 integration tests
  5. `docs/reviews/2026-06-29-auto-advance-workflow.md` — Source review
- **Next stage:** `06-docsync` — recommend syncing documentation
