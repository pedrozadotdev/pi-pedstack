---
title: Frozen Numeric Decision Tables Drift from Implemented Thresholds and Confidence Gates
category: workflow
severity: high
tags:
  - pedstack
  - requirements
  - plan
  - frozen-decision-table
  - numeric-threshold
  - confidence-gate
  - comparator
  - silent-narrowing
  - spec-conflict
  - contract-validation
  - strict-review
  - jev
  - drift-guard
  - verdict-derivation
  - calibration-constant
  - dead-constant
applies_when:
  - A plan freezes a table of numeric thresholds/comparators, not just type signatures
  - A verdict or signal is derived from a score and a confidence value together
  - A requirements doc makes a "supporting-only / never triggers" claim about an input
  - An exported calibration constant (limit, floor, version) is added without a reader
  - Running the 02-plan Strict Review or the 04-review requirements cross-check
  - A test asserts a threshold boundary rather than the requirement's decision table
---

# Problem

A plan froze a **numeric decision table** and the implementation shipped a different
one. Because every changed line still compiled, and the tests were written from the
code, the suite was green while three separate frozen rules had collapsed. The
divergence was caught only by a reviewer reading the plan's table row-by-row.

In the turn-level stage-drift feature (`extensions/ce-core/drift/`):

| Frozen rule (plan §6.2/§6.3, requirements res #13) | Shipped code | Consequence |
|---|---|---|
| `forbidden_work >= 0.60` → **mild**; `>= 0.80` **and** `confidence >= 0.60` → **strong** | one `FORBIDDEN_STRONG = 0.6`; any `forbidden` → `strong_drift`, **no confidence gate** | a 0.6–0.79 answer (or a low-confidence one) hard-blocks the cross-stage save in `enforce` |
| a missing answer `confidence` must not satisfy the confidence floor | `rawConfidence === undefined ? 1 : rawConfidence` | an answer with no confidence silently bypasses *every* gate |
| `progress` is **supporting-only** — "it never triggers a verdict" | `soft` counts `progress`, so one progress-only turn → `mild_drift` | a legitimately slow/exploratory turn injects a "made no progress" correction |
| `MILD_REPEAT_LIMIT = 2` governs recurrence | exported constant with **zero readers**; `deriveVerdict` hardcodes `priorMild >= 1` | the calibration knob is dead; changing it changes nothing |

The type names all matched. Only the **numbers and the predicates around them**
diverged, and those are not in a signature block.

# Context

- `02-plan` produced and "Strict Reviewed" a frozen signature block plus a separate
  §6.2 threshold table. The Strict Review checked internal consistency and type
  agreement, but nothing diffed the threshold table against the final constants.
- `03-work` implemented the table it read, and wrote tests **from its own constants**
  (`tests/drift-combine.test.ts:140` asserts `0.6 → strong_drift`;
  `:179` asserts a progress-only turn is `mild_drift`). A test derived from the code
  can never detect a code/spec divergence.
- The same review found `MILD_REPEAT_LIMIT` exported but unread — the classic
  signature of a frozen knob whose call site was replaced by a literal.
- This is the numeric cousin of
  [`requirements-vs-plan-signature-divergence.md`](./requirements-vs-plan-signature-divergence.md).
  That card covers *types, unions, field sets, input sets, and arity*. This card covers
  **values, comparators, gates, and confidence floors** — the part of a spec that a
  signature diff does not see.

# Solution

## 1. Freeze the decision table as a table, not prose

The plan already had §6.2; the gap was that nothing consumed it as a checklist. Make
every cell of the table traceable:

```text
| Signal            | Compare | Threshold | Confidence gate | Verdict |
| forbidden_work    | >=      | 0.60      | (none)          | mild    |
| forbidden_work    | >=      | 0.80      | >= 0.60         | strong  |
| in_stage_scope    | <       | 0.50      | (none)          | soft    |
| progress          | —       | —         | —               | support-only, never triggers |
```

Every row must correspond to exactly one comparison expression in the code, and every
"never triggers" row must be provably absent from the trigger set.

## 2. Keep the confidence gate attached to its threshold

A threshold evaluated without its required confidence predicate is the most common
collapse, because the two conditions usually live in different functions:

```ts
// before — the threshold runs, the gate is lost
if (value("forbidden_work") >= FORBIDDEN_STRONG) triggered.push("forbidden_work");

// after — the gate is part of the same expression
const forbiddenStrong =
  value("forbidden_work") >= FORBIDDEN_WORK_STRONG &&
  confidence("forbidden_work") >= STRONG_CONFIDENCE;
```

Model the frozen tiers as named constants, not one merged constant
(`FORBIDDEN_WORK_MILD`, `FORBIDDEN_WORK_STRONG`, `STRONG_CONFIDENCE`), so a diff can
see which tier changed.

## 3. Absent confidence is untrusted, never 1

```ts
// before — absent confidence silently passes every floor
const confidence = rawConfidence === undefined ? 1 : rawConfidence;

// after — absent/unparseable confidence degrades the answer
if (!Number.isFinite(rawConfidence)) return degraded("missing_confidence");
```

Defaulting to the maximum is a fail-open on the one field that was supposed to bound
false positives.

## 4. Exclude "supporting-only" signals from the trigger set

If a requirements line says an input never triggers a verdict, it must be absent from
the count that creates one — it may still be logged or used in the reason:

```ts
// progress is display/calibration only; it never creates a verdict
const soft = triggered.filter(
  (id) => id !== "forbidden_work" && id !== "progress",
).length;
```

## 5. Every exported calibration constant needs a reader

`MILD_REPEAT_LIMIT` was added, exported, and asserted equal to 2, but never read.
Either wire it into the comparison (`priorMild >= MILD_REPEAT_LIMIT - 1`) or delete it;
a constant with no reader is a frozen knob that has already been silently replaced.

# Why this works

- **A table survives a signature diff that numbers do not.** Type-level diffs match
  names and shapes; a threshold is a literal inside a comparison, so it is invisible
  to both the type checker and a signature review.
- **Code-derived tests cannot falsify the code.** The boundary tests (`0.6 → strong`)
  were written from the implementation's constants, so they *codified* the divergence
  instead of catching it. Only a test derived from the plan's table can.
- **Confidence is a gate, not a value.** Folding `>= 0.80 && conf >= 0.60` into
  `>= 0.6` raises false-positive hard blocks precisely where the plan chose a
  correctable mild signal.
- **A default of 1 inverts the floor.** The field that existed to bound confidence
  becomes a no-op when absent, so the strictest-sounding rule is the easiest to bypass.
- **An unread constant is the fossil of a removed call site** — a cheap, deterministic
  signal that a frozen knob has already drifted.

# Prevention

- **In `02-plan`, require the threshold table to be the normative artifact** and the
  constants to be listed next to it. Annotate every threshold/comparator with its
  requirement id, exactly as the signature block is annotated.
- **Add a requirements↔constants diff to Strict Review and `04-review`:** for each row,
  cite the code expression that implements it. An unmatched row, a missing confidence
  gate, or a merged constant is a finding. Treat "code matches plan" and "constants
  match the frozen table" as two checks.
- **Never default a missing confidence to 1.** Treat absent/unparseable confidence as
  degraded, and add the negative test (missing confidence → not strong).
- **Add a "never triggers" conformance test:** for each supporting-only input, feed it
  alone and assert the verdict stays `no_drift`.
- **Grep every exported calibration constant for a reader** (`MILD_REPEAT_LIMIT`,
  `*_LIMIT`, `*_FLOOR`, `*_VERSION`). Zero readers is a finding, not a style nit.
- **Write threshold tests from the plan table, not from the constants** — parameterize
  the test on the frozen values so a later collapse fails the suite.

# Downstream Impact

### For `02-plan`

- Freeze numeric thresholds and confidence gates as an explicit table with requirement
  ids; name each tier as its own constant rather than merging them.
- State the supporting-only inputs and add their "alone stays no_drift" case to the
  test diagram.

### For `04-review`

- Diff the frozen decision table row-by-row against the implemented comparisons; a
  threshold without its confidence predicate is a finding.
- Check that absent confidence is treated as untrusted, and that every exported
  calibration constant has a reader.

## Related solutions

- [`./requirements-vs-plan-signature-divergence.md`](./requirements-vs-plan-signature-divergence.md)
  — the type/signature/field-set/input-set half of the same class. This card is the
  numeric half (values, comparators, confidence gates).
- [`../architecture/keep-degraded-fallbacks-out-of-primary-signal-state.md`](../architecture/keep-degraded-fallbacks-out-of-primary-signal-state.md)
  — sentinel/default values feeding a threshold; the "absent confidence defaults to 1"
  rule is the same failure with a default instead of a fallback.
- [`../architecture/shadow-mode-is-not-free-on-awaited-hooks.md`](../architecture/shadow-mode-is-not-free-on-awaited-hooks.md)
  — the fail-closed findings from the same review, including why the drift completion
  floor cannot key on `!fresh`.

## Provenance

- **Issue:** [#8 — Detect turn-level stage drift and inject correction](https://github.com/pedrozadotdev/pi-pedstack/issues/8)
- **Source review:** `docs/reviews/2026-10-06-turn-level-stage-drift-correction.md`
  (Findings H1, H3, L3, M5)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T15-21-10-752Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-06-turn-level-stage-drift-correction-requirements.md`
  (resolution #13 supporting-only; #7 fail-closed narrow to transport/partial)
- **Plan:** `docs/plans/2026-10-06-turn-level-stage-drift-correction-plan.md` (§6.2/§6.3 threshold table)
- **Source files:**
  - `extensions/ce-core/drift/combine.ts` — `FORBIDDEN_STRONG`, `computeSignals`, `deriveVerdict`, `readAnswers`, `MILD_REPEAT_LIMIT`
  - `tests/drift-combine.test.ts:140` / `:179` — tests that codify the collapsed table
- **Status:** findings recorded; fix (restore the tiered table + confidence gate) deferred
  to `04-5-debug` / `03-work`. No source was modified in `05-learn`.

## 🧠 Context Status

- **Health:** good — learning captured from the 04-review findings; no source was modified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/workflow/frozen-decision-tables-drift-from-implemented-constants.md`,
  `extensions/ce-core/drift/combine.ts`,
  `docs/plans/2026-10-06-turn-level-stage-drift-correction-plan.md`,
  `docs/reviews/2026-10-06-turn-level-stage-drift-correction.md`
- **Recommendation for `06-docsync`:** link this card from the drift feature docs and the
  requirements/plan follow-up list; if the single-threshold semantics are kept, bump
  `THRESHOLDS_VERSION` and amend §6.2 rather than leaving the plan table normative.
