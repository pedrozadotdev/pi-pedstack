---
title: A Green Test Runner Is Not a Type-Check — a Transpile-Only `bun test` Hides Required-Field Breaks
category: testing
severity: high
tags:
  - pedstack
  - typescript
  - type-safety
  - strict-mode
  - tsc-noemit
  - bun-test
  - transpile-only
  - ci
  - required-field
  - test-fixture
  - object-literal
  - ts2741
  - verification-gap
applies_when:
  - Adding a field to a shared TypeScript interface, or changing an optional field to required
  - A test file builds an object literal annotated with that interface instead of using a factory
  - The test runner strips types without checking them (`bun test`, `esbuild`, `vitest` without `--typecheck`, `ts-node --transpile-only`, `swc`)
  - The project declares `"strict": true` but CI runs only the test runner
  - Reviewing a diff that extends a shared `Evidence` / props / DTO type
  - A handoff or review claims "all green" on the strength of `bun test` alone
---

# Problem

Making a new field **required** on a shared interface is a whole-repo migration. Every
object literal annotated with that type must be updated. If the only automated check is a
transpile-only test runner, the migration silently lands half-done: the tests pass, and the
type graph is broken.

Concretely, in this change (`Evidence.priorGate` made required):

```typescript
// extensions/ce-core/stage-gate/types.ts — the new required field
export interface Evidence {
  // …existing fields…
  /** Prior fresh gate decision for this stage; null when absent/stale (Unit 4). */
  priorGate: { verdict: StageGateVerdict; action: ReviewAction } | null;
}

// tests/overengineering-engine.test.ts — stale hand-built literal, no error under bun test
function evidenceWith(txt: string): Evidence {
  return {
    stage: "04-review",
    repoRoot: root,
    // …13 fields…
    obligations: null,
    // priorGate missing here        ← never flagged by `bun test`
  };
}
```

| Command | Result |
| --- | --- |
| `bun test` | 1537 pass / 2 skip / 0 fail (88 files) |
| `bun x tsc --noEmit` (repo `strict: true`) | **1 error** — `tests/overengineering-engine.test.ts(99,2)` `TS2741: Property 'priorGate' is missing in type '{…}' but required in type 'Evidence'` |

The base commit had no `priorGate`, so the break was introduced by this change. Bun's test
runner erases types before executing them, and `.github/workflows/test.yml` ran only
`bun test` — so CI could never show it.

# Context

Surfaced as the single **HIGH** finding of the `04-review` of the conditional-independent-review
change (`docs/reviews/2026-02-14-conditional-independent-review.md`). `tsconfig.json` sets
`"strict": true` and includes `tests/**/*.ts`; `AGENTS.md` states "TypeScript strict mode" as
a project contract. Nothing enforced that contract in automation:

- `package.json` scripts: `"test": "bun test"` — no `typecheck` script.
- `.github/workflows/test.yml`: `bun install` then `bun test` — no `tsc --noEmit` step.

Why it matters beyond one fixture: `priorGate` is the evidence field the review-policy
feature reads to decide whether a findings sidecar is required. A test helper that
constructs an `Evidence` without it is not merely stale — it means the test's input no longer
matches the production contract, and the *only* mechanism that would have noticed (the type
checker) was switched off by the harness. Making the field required was load-bearing: the
type-checker is how you enumerate the migration sites; disabling it turns a mechanical
migration into "compiles everywhere I happened to look".

Overlap check against `docs/solutions/` (grep on titles, tags, and `applies_when`): **Low**.
No existing card covers transpile-only runners, a missing CI type-check step, or
required-field migrations. The closest neighbours are the contract-completeness family
(`workflow/requirements-vs-plan-signature-divergence.md`,
`workflow/model-facing-result-contracts-must-enumerate-every-outcome.md`) and the same
change's other learning (`workflow/clean-review-deadlocks-findings-persistence-gate.md`);
they share a "the contract has more cases than the check" theme but a different mechanism
and a different fix, so this is a new card, cross-linked rather than merged.

# Solution

Fix the instance, then close the class of bug.

1. **Update every stale literal.** Add `priorGate: null` (or the real value) to the
   `Evidence` fixture. Let `tsc --noEmit` be the completeness check for the migration — it
   lists every construction site, so run it *until it is clean*, not until the obvious
   offender is gone.
2. **Run the type-check in CI.** Add one step after the tests (or before, if you prefer
   failing fast):

```yaml
# .github/workflows/test.yml
      - run: bun install
      - run: bun x tsc --noEmit   # ← the strict-mode contract, enforced
      - run: bun test
```

   Optionally expose it as `"typecheck": "tsc --noEmit"` in `package.json` so local runs,
   CI, and review verification share one command.
3. **Centralize shared-contract construction.** A single `evidenceWith(...)` factory means
   the *next* required field is a one-line fix in one place instead of N hand-rolled literals.
   Hand-built literals are the reason a required-field change is risky at all.
4. **Correct the verification claim.** "All green" is only ever "tests green" when the
   runner is transpile-only. When a shared type changed, the verification record must carry
   both `bun test` and `bun x tsc --noEmit`.

# Why this works

- **Transpile-only runners erase the evidence.** Bun (like `esbuild`, `swc`, and `ts-node
  --transpile-only`) strips type syntax and executes the result. A type error is deleted
  before it can fail anything, so `TS2741` is invisible to the runner by construction — this
  is not a coverage gap that more tests close.
- **A required field is an interface change, and the compiler is the migration tool.** No
  amount of runtime testing will enumerate object-literal sites; only the checker does.
- **CI is the enforcement point for a declared contract.** If the only automated gate is the
  transpile-only runner, `"strict": true` is a local convention that decays on the first
  multi-file type change.
- **The failure is silent and confidence-increasing.** The suite reports 0 failures, which
  actively discourages looking further — the same signal pattern as the project's
  `clean-review-deadlocks-findings-persistence-gate` learning: an empty/positive result that
  is not evidence of the property you think it is.

# Prevention

- **When you make a field required, treat `tsc --noEmit` as part of the edit**, not as a
  follow-up. Any error it prints is unfinished work in the same change, and the error list is
  the migration checklist.
- **Keep a typecheck step in CI for any TypeScript repo whose tests run under a transpile-only
  runner.** Add it the moment the project declares `strict: true`.
- **Prefer a factory over a hand-built literal** for shared gate/DTO/evidence types; keep the
  one place so an additive required field stays a one-line change.
- **In review, never accept `bun test` green as a type-safety verdict.** If the diff touches a
  shared type, run `bun x tsc --noEmit` and report the two commands separately.

## Downstream Impact

### For 02-plan

- Any unit that adds a required field to a shared interface must carry a `tsc --noEmit`
  acceptance check plus an explicit "update every construction site" step, and list hand-built
  test fixtures as known migration sites in the test diagram.
- If the repo's CI does not type-check, plan the CI step as part of the change, or record the
  absent type-check as a deliberate, tracked gap with a follow-up — do not assume it is fine
  because the tests pass.

### For 04-review

- Add `bun x tsc --noEmit` to the verification table whenever the diff touches a shared type
  or an `Evidence`-like contract. A green `bun test` with a red `tsc` is a **blocking
  type-safety finding** (P0/P1), not an informational note — the repo declares strict mode.
- When a HIGH finding is "not fixable in 04-review" (no code edits allowed), say exactly which
  one-line change is required and which stage owns it, so the next stage cannot miss it.

## Related solutions

- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — the general "a declared contract has more sites/cases than the check" family this card
  belongs to.
- [`../workflow/model-facing-result-contracts-must-enumerate-every-outcome.md`](../workflow/model-facing-result-contracts-must-enumerate-every-outcome.md)
  — enumeration discipline for contracts that consumers branch on.
- [`../workflow/clean-review-deadlocks-findings-persistence-gate.md`](../workflow/clean-review-deadlocks-findings-persistence-gate.md)
  — the other learning from the same change; `priorGate` is that card's conditional input.

## Provenance

- **Source review:** `docs/reviews/2026-02-14-conditional-independent-review.md`
  (HIGH finding, reviewers: correctness / thoroughness).
- **Source plan:** `docs/plans/2026-02-14-conditional-independent-review-plan.md`
  (Unit 4 introduced the required `Evidence.priorGate`).
- **Source files:** `extensions/ce-core/stage-gate/types.ts`,
  `tests/overengineering-engine.test.ts` (`evidenceWith`), `tsconfig.json`,
  `.github/workflows/test.yml`, `package.json`.
- **Reproduce:** `bun x tsc --noEmit` → `tests/overengineering-engine.test.ts(99,2): TS2741`;
  `bun test` → all pass.
- **Status:** defect confirmed at capture; the one-line fixture fix is deferred to
  `04-5-debug` / a `03-work` re-entry because `04-review` must not modify code.

## 🧠 Context Status

- **Health:** good — the gap, its exact evidence, and both the instance fix and the CI fix
  are captured; no source code changed in this stage.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/testing/green-test-runner-is-not-a-type-check.md`,
  `extensions/ce-core/stage-gate/types.ts`, `tests/overengineering-engine.test.ts`,
  `.github/workflows/test.yml`, `docs/reviews/2026-02-14-conditional-independent-review.md`
- **Recommendation for `06-docsync`:** record the CI type-check gap (and the deferred
  `priorGate: null` fixture fix) in `README.md` known limitations / `AGENTS.md` verification
  guidance; do not weaken the `strict: true` contract.
