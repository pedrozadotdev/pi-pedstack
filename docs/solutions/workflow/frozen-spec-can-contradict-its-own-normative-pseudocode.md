---
title: A Frozen Spec Can Contradict Itself — Diff the Example Matrix Against Its Normative Pseudocode
category: workflow
severity: high
tags:
  - pedstack
  - requirements
  - plan
  - frozen-decision-table
  - verdict-matrix
  - pseudocode
  - spec-internal-consistency
  - normative-artifact
  - row-for-row
  - acceptance-criteria
  - test-rewrites-the-table
  - silent-deviation
  - drift-guard
  - repeated-mild
  - jev
applies_when:
  - A requirements or plan document freezes BOTH an explicit example matrix and a procedural derivation pseudocode
  - An acceptance criterion says "reproduces the frozen table row-for-row"
  - A test would have to inject an input the frozen table does not list to keep an expected output green
  - Two encodings of the same rule (table vs pseudocode) are authored by hand instead of generated from one source
  - Running the 02-plan Strict Review or the 04-review requirements cross-check
  - Reviewing a verdict/signal derivation that has a hand-written example table
---

# Problem

This is the **spec-versus-itself** sibling of
[`frozen-decision-tables-drift-from-implemented-constants.md`](./frozen-decision-tables-drift-from-implemented-constants.md).
That card is about code drifting from a frozen table. This card is about the **frozen
spec drifting from its own normative pseudocode** — and a test silently rewriting the
table row so the conflict stays green.

In the turn-level stage-drift correction pass
(`docs/brainstorms/2026-10-06-turn-level-stage-drift-corrections-requirements.md`,
`docs/plans/2026-10-06-turn-level-stage-drift-corrections-plan.md`) the same document
froze two encodings of one rule:

```text
# Verdict derivation VD-4 (stated as the normative algorithm)
soft         = [in_stage_scope < 0.50] + [scope_drift >= 0.60] + [forbiddenMild]
repeatedMild = soft == 1 && priorConsecutiveMild >= limit - 1
if forbiddenStrong || soft >= 2 || repeatedMild -> strong_drift
```

```text
# Explicit verdict matrix (labelled "the spec the tests must match"), row 8
| in_scope | forbidden | scope_drift | progress | priorMild | verdict |
| 0.90     | 0.10      | 0.10        | 0.10     | 1         | strong (repeated mild) |
```

Row 8 has **all signals in scope**, so `soft == 0`, so `repeatedMild` is `false` under
VD-4. The row's stated verdict (`strong`) is **unreachable**. The two frozen encodings
contradict each other:

- If the matrix is normative, recurrence must be able to escalate a turn with **no** soft
  signal, and the `soft == 1` conjunct in VD-4 is wrong.
- If VD-4 is normative, matrix row 8 is wrong and must be re-expressed (e.g. with one soft
  trigger).

The implementation chose VD-4. The test then **repaired the table** instead of failing:

```ts
// tests/drift-combine.test.ts
// Matrix row 8 lists all-in-scope values with `priorMild=1`; VD-4
// requires `soft == 1`, so the recurrence row carries the soft
// trigger it depends on (documented deviation, see plan row 8).
name: "row 8: one soft signal with a prior mild → strong (repeated mild)",
dimensions: { in_stage_scope: 0.49, ... },
priorMild: 1,
```

Row 8 as written uses `in_scope: 0.90`; the test injects `in_stage_scope: 0.49` to make
`soft == 1`. Acceptance criterion AC-1 ("`deriveVerdict` reproduces the frozen table
row-for-row") therefore **cannot be literally satisfied** — the table was quietly
rewritten by the suite that was supposed to verify it.

# Context

- The requirements doc itself warns *"because the original plan is gone, this document is
  now normative; a later reviewer must diff code against the table above, not against
  constants"* — yet the table and the pseudocode inside that same document disagree. A
  self-consistency check was never run.
- The frozen-table card from the first pass already established "write tests from the
  table, not from the constants". The implementation followed the *spirit* (derive the
  matrix from a data table) but the **table it wrote was not the table the spec froze**:
  the data literal contains a deviation with an explanatory comment.
- A comment plus an "expected" value is how a spec conflict becomes invisible: the test is
  green, the deviation is documented in a comment no automated check consumes, and AC-1 is
  marked satisfied in the plan checkboxes.
- The 04-review correctness/thoroughness reviewer caught it only by reading matrix row 8
  and re-deriving it from VD-4. No test, type, or lint could see the contradiction because
  both encodings are prose.

# Solution

## 1. One normative artifact, the other derived — or an explicit consistency check

Do not hand-maintain two encodings of the same rule. Either:

- make the **pseudocode/derivation** normative and generate the example matrix from it
  (or drop the matrix), or
- make the **matrix** normative (its rows are the contract) and express the pseudocode
  only as the minimal rule that reproduces every row.

If both must exist for readers, add a check that evaluates each matrix row through the
derivation. A row whose inputs do not satisfy the branch its verdict names is a failing
spec test:

```ts
for (const row of MATRIX) {
  const verdict = deriveVerdict(dimsFrom(row), { priorConsecutiveMild: row.priorMild ?? 0 });
  assert.equal(verdict, row.expected, `matrix row ${row.id} not reproducible by VD-4`);
}
```

## 2. Never repair a frozen table row inside a test

When a table-derived test fails, the correct outputs are **spec deviation** or **code
defect** — not a test edit. If a test needs to add an input the frozen row does not list,
that is the signal that the spec is inconsistent. Fail the test, cite the row and the
pseudocode line, and route the conflict to a requirements decision.

```ts
// before — table rewritten so the suite stays green
dimensions: { in_stage_scope: 0.49 }, // "documented deviation, see plan row 8"

// after — assert the frozen row literally; a conflict fails loudly
dimensions: { in_stage_scope: 0.90 }, // exactly as row 8 froze it
// deriveVerdict(...) !== "strong" → spec-conflict failure, not a green test
```

## 3. Diff the matrix against the pseudocode expression-by-expression in review

For each matrix row, name the branch that can produce its verdict and confirm the row's
inputs make that branch true. Specifically check:

- a recurrence/`prior*` branch requires at least one current soft signal (the case here);
- a "streak" or "repeat" rule is not reachable on an all-clear turn;
- a row whose expected verdict is `strong` is not actually `soft >= 2` in disguise.

## 4. Resolve by confirming the normative artifact, then amend the other

The review's recommended action is the general one: **confirm which artifact is
normative before merge**, then fix the loser. If the matrix is intended (recurrence may
escalate an all-in-scope turn), remove the `soft == 1` guard and add a zero-soft
recurrence test. If VD-4 is intended, amend matrix row 8 so the frozen spec is internally
consistent. Shipping a normative table the implementation cannot reproduce is the one
outcome that is never acceptable.

# Why this works

- **A table and a procedural derivation are independent encodings.** Written by hand, they
  will disagree; nothing about a passing suite or a clean typecheck cross-checks prose
  against prose.
- **An "expected" value with a deviation comment is not a test.** It converts a spec
  conflict into a green assertion and destroys the only automated evidence that AC-1 held.
- **No static tool sees the contradiction.** Both halves are natural-language documents;
  only a row-by-row re-derivation (by a reviewer or a generated conformance test) can.
- **The acceptance criterion becomes unverifiable.** "Row-for-row" is a falsifiable claim
  only if the test uses the frozen rows verbatim; a rewritten row makes the criterion
  vacuous while the plan reports it green.

# Prevention

- **In `02-plan`, name the single normative artifact.** If a matrix and a derivation both
  appear, state which one wins and add a "every row must be reproducible by §<derivation>"
  acceptance check.
- **Freeze the matrix as data the tests import.** No per-row overrides, no "documented
  deviation" comments. The test file should contain the table verbatim.
- **Add a spec self-consistency test at `03-work`.** Evaluate every frozen matrix row
  through the derivation; a mismatch fails the build.
- **Treat a test-local deviation comment as a finding.** In `04-review`, grep the tests for
  `deviation`, `see plan row`, `requires … so` near a matrix row; any such comment means a
  frozen expectation was overridden.
- **Re-derive at least the recurrence/streak rows in review.** These are the rows most
  likely to encode an unreachable branch because the pseudocode carries an extra conjunct
  the table author forgot.

# Downstream Impact

### For `02-plan`

- Declare one normative encoding of each decision rule; if both a matrix and a derivation
  are kept, add the reproducibility check as an acceptance criterion.
- Give every matrix row a stable id so a review or test failure can cite the exact row.

### For `04-review`

- Diff each frozen matrix row against the normative derivation and confirm the named
  branch is reachable with the row's inputs.
- Flag any test whose data literal differs from the frozen row; a deviation comment is an
  automatic finding, not an accepted workaround.

## Related solutions

- [`./frozen-decision-tables-drift-from-implemented-constants.md`](./frozen-decision-tables-drift-from-implemented-constants.md)
  — the code-versus-table half (values, comparators, confidence gates). This card is the
  table-versus-its-own-pseudocode half.
- [`./requirements-vs-plan-signature-divergence.md`](./requirements-vs-plan-signature-divergence.md)
  — the type/signature half of spec drift.
- [`../architecture/shadow-mode-is-not-free-on-awaited-hooks.md`](../architecture/shadow-mode-is-not-free-on-awaited-hooks.md)
  — the front half of the same drift feature; this card documents the recurrence that
  surfaced in its correction review.

## Provenance

- **Issue:** [#8 — Detect turn-level stage drift and inject correction](https://github.com/pedrozadotdev/pi-pedstack/issues/8)
- **Source review:** `docs/reviews/2026-10-06-turn-level-stage-drift-corrections.md`
  (Finding H — matrix row 8 vs VD-4)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T18-01-27-036Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-06-turn-level-stage-drift-corrections-requirements.md`
  (explicit verdict matrix row 8; VD-4; AC-1)
- **Plan:** `docs/plans/2026-10-06-turn-level-stage-drift-corrections-plan.md`
  ("Explicit verdict matrix (the spec the tests must match)", "Verdict derivation (VD-1..VD-4)")
- **Source files:**
  - `extensions/ce-core/drift/combine.ts` — `const repeated = soft === 1 && priorMild >= limit - 1;`
  - `tests/drift-combine.test.ts:242-252` — row 8 rewritten with `in_stage_scope: 0.49` and a "documented deviation" comment
- **Status:** findings recorded; the normative-artifact decision and the resulting fix are
  deferred to `04-5-debug` / `03-work`. No source was modified in `05-learn`.

## 🧠 Context Status

- **Health:** good — learning captured from the 04-review findings; no source was modified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/workflow/frozen-spec-can-contradict-its-own-normative-pseudocode.md`,
  `docs/brainstorms/2026-10-06-turn-level-stage-drift-corrections-requirements.md`,
  `docs/plans/2026-10-06-turn-level-stage-drift-corrections-plan.md`,
  `extensions/ce-core/drift/combine.ts`,
  `tests/drift-combine.test.ts`
- **Recommendation for `06-docsync`:** link this card from the drift feature docs and the
  requirements/plan follow-up list; the open decision (matrix row 8 vs VD-4) must be
  resolved by amending whichever artifact loses, and the test's `documented deviation`
  comment must be removed once the frozen spec is made internally consistent.
