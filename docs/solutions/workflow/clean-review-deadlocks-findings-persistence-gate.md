---
title: A Clean Review Deadlocks a Findings-Persistence Gate That Requires at Least One Finding
category: workflow
severity: medium
tags:
  - pedstack
  - stage-gate
  - multi-reviewer
  - review-findings
  - deterministic-floor
  - deadlock
  - zero-findings
  - enforce
  - shadow-mode
  - handoff-gating
applies_when:
  - A deterministic gate predicate requires a persisted findings file to exist
  - The tool that produces that file treats an empty result as "nothing to persist"
  - A stage can legitimately complete with zero findings (a clean review)
  - `context_handoff save` is blocked by a critical check that can never be satisfied
  - Reviewing the interaction between `multi_reviewer` and the `04-review` stage gate
---

# Problem

`multi_reviewer` persists a findings file only when there is at least one finding:

```typescript
// extensions/ce-core/tools/multi-reviewer.ts
async function persistFindings(...): Promise<{ … } | null> {
  if (findings.length === 0) return null;   // 0 findings ⇒ no file written
  …
}
```

The `04-review` stage gate then requires exactly that file:

```typescript
// extensions/ce-core/stage-gate/rubrics.ts
check("review_findings_persisted", true, (e) => {
  const valid = e.reviewFindings.filter(
    (f) => Array.isArray(f.findings) && f.count === f.findings.length,
  );
  return valid.length >= 1
    ? pass(`${valid.length} findings file(s) persisted`)
    : fail("no parseable findings file with count === findings.length");
});
```

`true` means **critical**, so the check blocks in both `shadow` and `enforce`. Together the
two halves form a deadlock: a genuinely clean `04-review` run (the desired outcome!) produces
zero findings, `persistFindings` writes nothing, and the gate can never pass. Because
`context_handoff save` re-runs the deterministic floor on every cross-stage completion save,
the workflow cannot advance out of a clean review — the better the review, the harder the
block.

# Context

Surfaced in `pi-pedstack` during the untrusted-tool-result injection screen review
(`docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`, "Audit Feedback"
section). The compiled review report contained findings, but the `multi_reviewer` pass over
that report returned **0 findings** from its single reviewer model, and the audit note
recorded that "the tool did not emit a `findingsRelativePath` (0-finding runs persist
nothing under `.context/compound-engineering/review-findings/`)".

This is not unique to a quiet reviewer model. Any stage whose correctness rubric depends on
the *artifact of a tool run* rather than the *stage's own output* inherits the same failure
mode whenever the tool's success case is "empty". The gate predicate is deliberately
fail-closed (an unvalidated or missing record means block), which is the right default — but
it was written without an exhaustiveness check for "tool ran, tool succeeded, tool found
nothing". The review stage's own report was the durable artifact, yet the gate looked only
for the tool's JSON sidecar.

Overlap check against `docs/solutions/`: this is the same subsystem as
`workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`, which documents that the
deterministic floor blocks in both modes and that artifact resolution must have one
stage-scoped identity. This card is a distinct, narrower defect (a predicate that cannot be
satisfied by a valid success case), so it is new and cross-linked rather than merged; it is
also related to `tooling/fallow-findings-for-inert-module-barrel.md` (tool output that is
legitimately empty).

# Solution

Pick one of two fixes; do not leave the interaction unspecified:

1. **Persist the empty result.** Write a findings file with `count: 0, findings: []` when the
   run is clean, so the gate's `Array.isArray(f.findings) && f.count === f.findings.length`
   holds and the predicate passes. This keeps the gate's "a file is evidence the tool ran"
   contract intact and makes a clean run auditable.
2. **Make the predicate distinguish "not run" from "found nothing".** Allow the predicate to
   pass when a clean run is otherwise evidenced (the stage's compiled report plus a recorded
   `multi_reviewer` invocation), instead of requiring a non-empty sidecar. This is the
   smaller change if the stage report is already the canonical artifact.

For the current `pi-pedstack` state, the workaround is to treat the compiled review report
as the durable findings artifact and record the 0-finding `multi_reviewer` run explicitly in
that report (as the review did), then track the gate/tool interaction as a separate fix.

Whichever path is chosen, add a test with a **0-finding** fixture:

```typescript
// clean run: tool succeeds, writes nothing (or writes count:0)
expect(evaluateDeterministic(pickRubric("04-review"), cleanEvidence).every((c) => c.pass))
  .toBe(true);
```

# Why this works

- **The bug is a missing case in a total function, not a wrong default.** Fail-closed on a
  missing/unvalidated record is correct; failing closed on a *successful empty* result is
  the bug. Enumerating the tool's outcomes (ran-and-found, ran-and-empty, did-not-run,
  malformed) makes the gap visible.
- **A gate must be satisfiable by every valid completion of its stage.** "Clean review" is a
  valid completion. If no input to the gate can satisfy a critical check in that state, the
  gate is not enforcing quality — it is deadlocking the workflow.
- **The stage's own artifact is the honest evidence.** The compiled report is written by the
  stage and describes what happened; the tool sidecar is evidence a tool executed. Coupling
  advancement to the sidecar alone makes tool output — not stage output — the gate.

# Prevention

- **Enumerate tool outcomes when a predicate depends on a tool artifact**, including the
  empty success case, and write a test for each.
- **When you add a critical gate predicate, ask "can a valid completion of this stage fail
  it?"** If yes, add the success case or narrow the predicate.
- **Prefer the stage's own artifact as the gate's contract** and use tool sidecars as
  corroboration, not as the sole key.
- **Record a 0-finding reviewer run in the durable report**, so the review is auditable even
  when the tool persists nothing.

## Downstream Impact

### For 02-plan

- When planning any gate that reads a tool-produced artifact, list the tool's outcome space
  (success-with-data, success-empty, not-run, malformed) in the plan's test diagram and
  require the empty-success case to be handled.

### For 04-review

- When a `multi_reviewer` run returns 0 findings, do not assume the gate is satisfied;
  record the run in the review report and flag the persistence interaction. Verify a
  clean-review path can actually advance.

## Related solutions

- [`./stage-artifact-completion-gate-shadow-first-rubrics.md`](./stage-artifact-completion-gate-shadow-first-rubrics.md)
  — the deterministic floor plus stage-scoped identity; this card is the empty-success case
  that layer forgot.
- [`./requirements-vs-plan-signature-divergence.md`](./requirements-vs-plan-signature-divergence.md)
  — the broader "tool/contract outcome space not fully enumerated" family.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`
  ("Audit Feedback"; deferred open decision).
- **Source files:** `extensions/ce-core/tools/multi-reviewer.ts` (`persistFindings`),
  `extensions/ce-core/stage-gate/rubrics.ts` (`review_findings_persisted`),
  `extensions/ce-core/stage-gate/evidence.ts` (`readReviewFindings`).
- **Status:** interaction documented, not yet fixed; the compiled review report serves as
  the durable artifact for this run.

## 🧠 Context Status

- **Health:** good — defect and both fix options captured; no code changed.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/tools/multi-reviewer.ts`,
  `extensions/ce-core/stage-gate/rubrics.ts`,
  `extensions/ce-core/stage-gate/evidence.ts`,
  `docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`
- **Recommendation for `06-docsync`:** track the gate/tool interaction as a follow-up and
  note the 0-finding run handling in `CONTEXT.md`.
