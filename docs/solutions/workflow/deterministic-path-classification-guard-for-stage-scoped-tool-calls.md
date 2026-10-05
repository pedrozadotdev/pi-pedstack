---
title: Deterministic Path-Classification Guard for Stage-Scoped Tool Calls
category: workflow
severity: high
tags:
  - pi-extension
  - tool-call-guard
  - capability-matrix
  - path-classification
  - precedence
  - fail-open
  - active-stage
  - persisted-state
  - pure-function
  - thin-handler
  - error-isolation
  - regression-test
  - workflow-state
  - pedstack
applies_when:
  - Enforcing stage-scoped write/edit permissions from a repo-relative path in a pi extension
  - Building a pure classifier plus a thin fail-open `pi.on("tool_call")` guard
  - Ordering "first match wins" classification rules where one class must never be bypassed
  - Setting persisted active-stage state during a stage transition that can be cancelled
  - Writing exhaustive matrix tests that must also cover rule precedence, not just membership
  - Reducing a flat multi-branch classification function below the project complexity budget
---

# Problem

A pipeline's stage discipline is usually enforced by prompt text only. When the model ignores
the injected skill (context drift, compaction, or an adversarial instruction in tool output),
nothing stops it from calling `write`/`edit` on a path that belongs to another stage — e.g. a
`02-plan` session editing `extensions/` source.

A deterministic guard can close that gap for the path-classifiable `write`/`edit` surface:

1. one typed capability matrix (stage → writable path classes),
2. a pure path classifier (`classifyPath` → 11 classes),
3. a pure evaluator (`evaluateWrite`),
4. a thin `pi.on("tool_call")` handler that returns `{ block: true, reason }` before the write
   executes, and
5. a durable active-stage value so the guard survives a restart.

Two subtleties make or break the guard, and both were discovered the hard way in review:

- **Rule precedence is the invariant.** Declaring `workflow-state` unwritable in the matrix is
  not enough; if a more specific rule (e.g. `*.test.ts`, `package.json`) matches first, the
  "always blocked" class is silently bypassed.
- **State activation must follow the fallible side effect.** Persisting the target stage before
  the navigation that can be cancelled/refused leaves the guard enforcing the wrong stage for
  the rest of the session and across restart.

# Context

Developed for the `pi-pedstack` ce-core extension's deterministic stage capability matrix (see
[source requirements](../../brainstorms/2026-10-05-workflow-deterministic-stage-capability-requirements.md),
[source plan](../../plans/2026-10-05-workflow-deterministic-stage-capability-plan.md),
[source review](../../reviews/2026-10-05-workflow-deterministic-stage-capability.md)).

Constraints that shaped the design:

- The classifier and evaluator must be pure — no I/O, no Pi imports — so they are unit-testable
  without an extension harness (same rule as
  [auto-advance.ts](../../../extensions/ce-core/utils/auto-advance.ts)).
- Functions < 50 lines, files < 800 lines; Fallow complexity budget below ~10 per function.
- Unknown paths/stages **fail open**; only a deterministically forbidden class blocks.
- `03-work`/`04-5-debug` may edit enforcement source (self-hosting product), so the guard cannot
  sandbox its own implementation stage.

The review of the first implementation found 1 high + 2 moderate + 5 low findings; `multi_reviewer`
independently reproduced all 8. The card records the reusable lessons, not the incident.

# Solution

## 1. Pure classifier + pure evaluator, thin handler

Keep all decision logic in one pure module. The handler only resolves the stage, calls the
evaluator, and maps the verdict to a Pi result — no policy in `index.ts`.

```ts
export type PathClass =
  | "brainstorm" | "plan" | "review" | "solution" | "docs"
  | "tests" | "source" | "config" | "deps" | "workflow-state" | "unknown";

export const STAGE_CAPABILITIES: Record<PipelineStageKey, ReadonlySet<PathClass>>;

export function classifyPath(repoRoot: string, rawPath: string): PathClass;

export interface WriteVerdict { allow: boolean; pathClass: PathClass; reason?: string }
export function evaluateWrite(
  stage: string | null | undefined, repoRoot: string, rawPath: string,
): WriteVerdict;
```

`evaluateWrite` order is explicit: `unknown` → allow; `workflow-state` → block; absent/unknown
stage → allow (fail open); otherwise allow iff the stage set contains the class. The block reason
is deterministic and names the stage, class, path, writable classes, and the env override.

```ts
// index.ts — thin, error-isolated handler
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const p = (event.input as { path?: unknown } | null)?.path;
  if (typeof p !== "string" || p.length === 0) return undefined; // fail open
  try {
    const stage = getActiveStage() ?? (await readPersistedActiveStage(ctx.cwd));
    const verdict = evaluateWrite(stage, ctx.cwd, p);
    return verdict.allow ? undefined : { block: true, reason: verdict.reason };
  } catch {
    return undefined; // never break the turn; optional once-per-session notify
  }
});
```

**Why pure + thin:** the matrix is testable as data, the evaluator is testable as a function, and
the handler stays small enough to remain under the 50-line / complexity budget. This mirrors the
[auto-advance card](./auto-advance-workflow-via-tool-result-interception-with-authorization-gates.md).

## 2. Ordered classification — put the never-writable class FIRST

This is the highest-value lesson. A "first match wins" rule list must place the class that is
**never** writable before any rule that could shadow it. The first implementation checked
`deps` (1), `config` (2), `tests` (7), `docs` (9) **before** `workflow-state` (10), so paths
whose *basename* matched a writable class escaped the invariant:

```
.context/compound-engineering/notes.test.ts   -> tests   (allowed in 03-work)
.context/compound-engineering/package.json    -> config  (allowed in 03-work)
.context/compound-engineering/bun.lock        -> deps    (allowed in 03-work)
.context/compound-engineering/README.md       -> docs    (allowed in 06-docsync)
.context/compound-engineering/context-state.json -> workflow-state (correctly blocked)
```

`STAGE_CAPABILITIES` correctly omitted `workflow-state` from every stage — the *matrix* was right,
the *classifier* never reached it. Fix: move the `.context/` check to position 1.

```ts
function classifyRelative(rel: string): PathClass {
  const base = path.posix.basename(rel);
  // Invariant class first — never shadowed by a basename rule.
  if (rel.startsWith(".context/")) return "workflow-state";
  if (DEPS_BASENAMES.has(base)) return "deps";
  if (CONFIG_BASENAMES.has(base) || rel.startsWith(".github/")) return "config";
  // ...artifact dirs before docs/, tests before source...
  return "unknown";
}
```

**General rule:** if a class is an absolute invariant ("always blocked"), it must be evaluated
before every softer rule. Encode the ordering in one place (a predicate table or ordered list)
so the invariant cannot be accidentally reordered later.

## 3. Commit state after the fallible step, not before

The guard persists the active stage so it survives restart. The first implementation activated the
target stage **before** confirming navigation:

```ts
// beginStageTransition (buggy ordering)
rememberCommandContext(ctx);
await activateStage(ctx.cwd, stageKey);          // ❌ persisted before nav is known to succeed
const nav = await prepareStageNavigation(ctx);
if (!nav) return false;                          // cancelled/failed -> wrong stage left behind
```

`prepareStageNavigation` returns `null` when there is no target leaf or the user cancels
`ctx.navigateTree(...)`. Activating first means a cancelled transition persists the *target* stage
while the session continues in the *source* stage: the guard then enforces the wrong matrix for
the rest of the session and across restart. `cmdPedFixIssues` already used the correct ordering
(nav first, then activate), which is what exposed the inconsistency.

```ts
// correct ordering in every transition entry point
const nav = await prepareStageNavigation(ctx);
if (!nav) return false;
await activateStage(ctx.cwd, stageKey);          // commit only after nav is confirmed
```

**General rule:** any state mutation that makes a *later* step irreversible (persisted stage,
consumed one-shot flag, registered handler) must happen after the step that can fail or be
cancelled — never before.

## 4. Resolve the stage from memory with a gated persisted fallback

The durable stage is a separate small file (`.context/compound-engineering/active-stage.json`)
rather than a field in the handoff-owned `context-state.json`, avoiding a second writer to one
JSON object. The reader is resilient and gated:

- in-memory value wins;
- otherwise read the persisted file, but trust it only when a workflow is actually in progress
  (`.context/compound-engineering/context-state.json` exists with a string `currentStage`);
- missing/corrupt file → `null` (never throw) → fail open;
- persistence failure during dispatch is swallowed (in-memory still covers the session).

This "staleness gate" prevents an old persisted value from over-blocking an ad-hoc session.

## 5. Test the rules, not only the matrix

An exhaustive 7×11 membership test is necessary but **not sufficient**. The first test asserted
`STAGE_CAPABILITIES[stage].has("workflow-state") === false` using a single non-conflicting
`.json` fixture, so the precedence leak was invisible. Add:

- **Conflicting-attribute fixtures**: `.context/**/*.test.ts`, `.context/**/package.json`,
  `.context/**/bun.lock`, `.context/**/README.md` must all classify as `workflow-state`.
- **Cancelled-navigation tests**: stub `navigateTree` to return `{ cancelled: true }` and assert
  `getActiveStage()` is unchanged and `active-stage.json` was not written.
- **Precedence fixtures**: `docs/brainstorms/x.md` → brainstorm (not docs);
  `extensions/foo.test.ts` → tests (not source); root `scripts/tool.mjs` → source.
- **Adversarial normalization**: `..` traversal into `extensions/`, mixed backslashes, absolute
  in-repo path, outside-repo path.

Rule: when a classifier uses an ordered rule list, every rule that can shadow another needs a
fixture that exercises both classes at once.

## 6. Keep the branch chain below the complexity budget

`classifyRelative` reached cyclomatic 16 / cognitive 15 as a flat 10-branch `if` chain (Fallow
`high-complexity`, crap 71.3), above the project norm. Replace the chain with an ordered predicate
table evaluated in one loop, or extract named prefix families:

```ts
const RULES: ReadonlyArray<{ test: (rel: string, base: string) => boolean; cls: PathClass }> = [
  { test: (rel) => rel.startsWith(".context/"), cls: "workflow-state" }, // invariant first
  { test: (_rel, base) => DEPS_BASENAMES.has(base), cls: "deps" },
  // ...
];
```

The table also makes the "invariant first" ordering explicit and self-documenting — the
precedence fix and the complexity fix are the same change.

## 7. Operator escape hatch, read once at init

`PEDSTACK_DISABLE_GUARD === "1"` is read at extension init (not in the pure module, preserving
its no-I/O boundary). Any read error defaults to **enforcing** (fail-safe). Operator-only — the
model cannot set the running process's env.

# Why this works

- **The cap is only as strong as its weakest rule.** A precise matrix with a mis-ordered classifier
  is a false guarantee. Making the invariant class the first rule turns "workflow-state is always
  blocked" from documentation into behavior.
- **State that outlives the failure misleads later turns.** Persisting the target stage before the
  navigation is confirmed converts a user cancel into a durable wrong-stage guard. Deferring the
  write to after the confirmation keeps memory and disk consistent with reality.
- **Fail-open on the unprovable is the correct default.** Unknown class/stage allows; only a
  deterministic foreign class blocks. This avoids bricking ad-hoc editing while still closing the
  common bypass.
- **Pure core + thin handler keeps the guard testable and cheap to verify.** The matrix is data,
  the evaluator is a function, and the handler cannot drift into policy.

# Prevention

- **Order invariant classes first** in any first-match classifier; express the ordering as a table
  so it cannot be silently reordered.
- **Commit persisted/irreversible state after the step that can fail or be cancelled** — navigation,
  confirmation, network, or validation. Mirror the ordering across every entry point (the
  inconsistency between `beginStageTransition`/`cmdPedStart` and `cmdPedFixIssues` is the tell).
- **An exhaustive matrix test is necessary but not sufficient** — add fixtures that combine
  conflicting attributes and a cancelled-side-effect test for each state transition.
- **Add a regression test with the fix**, not just the code change: precedence fixtures and a
  cancelled-navigation assertion.
- **Refactor a flat multi-branch classifier into a predicate table** once it passes ~10 branches —
  it fixes complexity and makes precedence auditable in one move.
- **Keep the escape hatch operator-only and fail-safe** (default to enforcing on any read error).
- **Document residual risks explicitly** (bash/indirect writes, symlink aliasing, unknown
  non-listed config basenames) so an `unknown`-allowed path is a known decision, not an accident.

## Downstream Impact

### For 02-plan

When planning any stage-scoped guard or permission layer:

1. Specify the classifier as an **ordered** rule list and state which class is the hard invariant;
   put it first in the plan's table.
2. Add a "state ordering" row to the temporal/error map: *activate/persist target stage only after
   navigation or confirmation succeeds*.
3. Plan precedence fixtures and a cancelled-navigation test up front; an exhaustive membership
   table alone will not catch a shadowed invariant.
4. Budget classifier complexity (< ~10) from the start — plan the predicate-table shape.

### For 04-review

When reviewing guards, classifiers, or stage-transition code:

1. **Flag any "always blocked/allowed" class that is not the first rule** in the classifier.
2. **Flag `activateStage`/persist calls that precede a `navigateTree`/confirmation null-check**;
   compare all transition entry points for ordering consistency.
3. **Flag exhaustive-matrix tests that reuse a single non-conflicting fixture** — request
   conflicting-basename fixtures.
4. **Flag a cancelled navigation with no test** asserting state is unchanged.
5. **Flag branch chains above ~10** and require a predicate table or extracted families.
6. **Confirm the env escape hatch is operator-only and defaults to enforcing** on read failure.

## Related learnings

- [auto-advance-workflow-via-tool-result-interception-with-authorization-gates.md](./auto-advance-workflow-via-tool-result-interception-with-authorization-gates.md) — the pure-verdict-module + thin error-isolated handler template reused here; also the source of the failure-mode-registry → test-map practice.
- [tool-based-task-tracking-with-handoff-gating.md](./tool-based-task-tracking-with-handoff-gating.md) — corrupt-file resilience for state readers, backslash normalization, and the prior high-cyclomatic→low refactor precedent.
- [child-process-event-listener-mock-for-pi-extension-tests.md](../testing/child-process-event-listener-mock-for-pi-extension-tests.md) — the fake-`pi` harness used to emit synthetic `write`/`edit` events and assert block/allow.

## Provenance

- **Source requirements:** `docs/brainstorms/2026-10-05-workflow-deterministic-stage-capability-requirements.md`
- **Source plan:** `docs/plans/2026-10-05-workflow-deterministic-stage-capability-plan.md`
- **Source review:** `docs/reviews/2026-10-05-workflow-deterministic-stage-capability.md`
- **Source files:**
  - `extensions/ce-core/utils/capability-matrix.ts` — pure classifier, matrix, evaluator
  - `extensions/ce-core/utils/active-stage.ts` — memory + gated persisted fallback
  - `extensions/ce-core/commands/pedstack.ts` — `beginStageTransition`/`cmdPedStart`/`cmdPedFixIssues` activation ordering
  - `extensions/ce-core/index.ts` — `tool_call` guard wiring
  - `tests/capability-matrix.test.ts`, `tests/stage-capability-guard.test.ts`, `tests/active-stage.test.ts`

---

## 🧠 Context Status

- **Health:** good
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  1. `docs/solutions/workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`
  2. `extensions/ce-core/utils/capability-matrix.ts`
  3. `extensions/ce-core/commands/pedstack.ts`
  4. `extensions/ce-core/index.ts`
  5. `docs/reviews/2026-10-05-workflow-deterministic-stage-capability.md`
- **Next stage:** `06-docsync` — recommend syncing documentation
