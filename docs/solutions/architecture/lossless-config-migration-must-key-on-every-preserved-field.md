---
title: A "Migratable" Verdict Must Key on Every Preserved Field — Not Just the Primary Key
category: architecture
severity: high
tags:
  - pedstack
  - config-migration
  - codemod
  - dry-run
  - lossless
  - behavior-preserving
  - fold
  - model-role
  - thinking-level
  - data-loss
  - pre-existing-target
  - idempotent
applies_when:
  - Writing a helper that folds or compacts N per-scope settings into K shared slots
  - The helper reports a status like "migratable" / "lossless" / "safe" and offers a write/dry-run
  - The source records carry more than one field that must survive (e.g. model + thinkingLevel)
  - The destination block may already exist in the input config
  - Reviewing a codemod, migration, or config-normalization diff
  - A dry-run prints a diff that an operator can apply with `--write`
---

# Problem

A dry-run role-migration helper decided whether a per-stage config could be folded
into three shared model roles, and it answered **`migratable` while losing data on
two independent axes**. Both losses were invisible in the printed summary and only
materialized when `--write` was applied.

**Axis 1 — the fold key was narrower than the preserved state.**
`extensions/ce-core/utils/role-migration.ts` collected the distinct per-stage
`model` values (`:99`, `:164`) as the migration unit, but each stage also carries a
`thinkingLevel`. `roleFor()` (`:122-129`) then picked the *first* stage that
supplied a model and copied only that stage's level:

```typescript
const roleFor = (model: string): StepConfig => {
  const source = foldable.find(
    (entry) => entry.model === model && entry.thinkingLevel !== undefined,
  );
  return source?.thinkingLevel
    ? { model, thinkingLevel: source.thinkingLevel }
    : { model };
};
```

Reproduction (matching the live `~/.pi/pi-pedstack/config.json`, where `work`/`debug`
use `max` and `learn` uses `high` **on the same model**):

```typescript
buildRoleMigration({
  work:  { model: "m/one", thinkingLevel: "max" },
  learn: { model: "m/one", thinkingLevel: "high" },
});
// status: "migratable"
// roles:  { default: { model: "m/one", thinkingLevel: "max" } }
//         ^ learn's "high" is silently upgraded to "max"
```

The `>3 distinct models` guard (`:165`) counts distinct *models*, so two levels on
one model pass every check. The only level-preservation test
(`tests/role-migration.test.ts`) used two *distinct* models, so the lossy case had
no coverage.

**Axis 2 — the fold ignored pre-existing target state.**
`buildRoleMigration` computed `roles` from the foldable stages alone and then
assigned unconditionally (`:182`):

```typescript
nextConfig.models = roles;   // clobbers any operator-authored models block
```

Reproduction:

```typescript
buildRoleMigration({
  models: { review: { model: "existing/reviewer" } },
  plan:   { model: "A" },
  work:   { model: "B" },
});
// status: "migratable"
// nextConfig.models === { default: { model: "A" }, review: { model: "B" } }
// existing/reviewer is gone
```

`models.review` is the real reviewer role read by `resolveReviewRole`
(`extensions/ce-core/tools/multi-reviewer.ts`), so an operator who had already
configured an independent reviewer silently got a different one after `--write`.

Both are the same class of defect: **the helper's success claim ("behavior-preserving",
"migratable") was not total over the state it promised to preserve.**

# Context

Surfaced as the single **HIGH** finding (H1) plus the top **MODERATE** finding (M1)
of the `04-review` of the model-role routing + conditional-review close-out
(`docs/reviews/2026-10-06-model-routing-conditional-review-closeout.md`), from plan
Unit 8 (G6), which asked for "a deterministic helper that reports whether a
behavior-preserving three-role migration exists … writes only … when the mapping is
lossless."

The plan's design text said "Preserve each role's `thinkingLevel` from the stage
that supplied it" — but with one model supplying several levels there is no single
"stage that supplied it", and the code silently chose one. The plan also did not
name the pre-existing-`models` case at all, so the destination was never treated as
input. Deterministic, no-Jev helpers are exactly where this hides: the summary line
is authoritative-looking and the loss is only in a field the summary does not show.

Why it matters beyond this config: config migrations are the one operation where a
"success" verdict grants permission to destroy the previous state. A helper that is
merely *usually* lossless is worse than no helper, because the dry-run diff looks
correct and the operator has been told it is safe.

# Solution

Treat the **full set of preserved fields** as the migration unit, and treat the
destination as input.

1. **Define the preserved tuple and key the fold on it.** If a stage contributes
   `(model, thinkingLevel)`, then the distinct unit is the pair:

   ```typescript
   const unit = `${entry.model}\u0000${entry.thinkingLevel ?? ""}`;
   ```

   The `>K distinct` cap is then a cap on distinct *tuples*, not distinct model
   names. Two stages with the same model and different levels are two units, not one.

2. **Refuse instead of guessing when the fold is lossy.** Add a `not_migratable`
   branch with a reason naming the conflicting values:

   ```typescript
   // one model, several levels, and no way to carry both
   reason: `model ${model} supplies conflicting thinkingLevels: max, high`;
   ```

   When the fold *can* carry the pair losslessly, carry it. When it cannot, return
   `not_migratable` and write nothing — the dry-run must not author a plan it cannot
   honor.

3. **Include the destination in the distinct analysis, and never blind-assign.**
   Merge with an existing target block, and refuse (or preserve) when a role the
   operator authored would be overwritten:

   ```typescript
   const existingRoles = config.models ?? {};
   // a role the fold does not intentionally produce must survive or block the plan
   if (collidesWithExisting(existingRoles, roles)) return notMigratable(...);
   ```

4. **Add the two RED tests the design implied.** A single model with two different
   `thinkingLevel`s (expect `not_migratable`, or a lossless pair-preserving fold),
   and a mixed `models` + per-stage config (expect the existing role to survive).
   Tests written from distinct-model examples cannot catch either case.

5. **Keep the write gate.** `--write` still applies only on `migratable`, and
   `not_migratable`/`noop` leave the file byte-identical (already implemented;
   the value is that the *verdict* is now honest).

# Why this works

- **"Behavior-preserving" is a claim over every preserved field.** A status of
  `migratable` is a promise; it must be computed from the whole tuple that has to
  survive, or it is a guess dressed as a guarantee.
- **`Array.prototype.find` first-match-wins is a silent representative choice.**
  When the key is narrower than the state, `.find()` looks deterministic but is
  actually "pick an arbitrary member and discard the rest" — exactly the shape of
  a data-loss bug that passes every happy-path test.
- **The destination is input, not a blank slate.** A migration tool that only reads
  the source under-counts the state it must not destroy; pre-existing authored
  config is the most likely thing an operator cares about.
- **Refusing is the safe default.** `not_migratable` costs an operator one manual
  edit; a lossy `migratable` costs them the configuration they had. For a
  destructive write, an over-conservative refusal is the correct failure direction.

# Prevention

- **Before writing any fold/compaction helper, list the fields the result must
  preserve.** If any preserved field varies independently of the nominal key, the
  key is wrong — widen it or add a conflict branch.
- **Make the default verdict `not_migratable`, and prove `migratable` positively.**
  A helper should have to *demonstrate* losslessness, not fail to notice loss.
- **Treat the existing target block as part of the input** and test a mixed
  pre-existing + per-scope config. Blind `target = computed` assignment is the
  config-migration equivalent of `rm -rf`.
- **Test the hard case the design text implies, not the easy one.** If the plan says
  "preserve X from the supplier", add a test where two suppliers disagree about X.
- **In review, when a helper reports `safe`/`lossless`/`migratable`, reproduce the
  claim on the *live* config.** Here the reviewer reproduced against the actual
  global config and found `learn: high` silently upgraded to `max` — the diff alone
  did not show it.

## Downstream Impact

### For 02-plan

- Any unit that introduces a fold/migration/codemod must name the full preserved
  tuple, the refusal condition, and the pre-existing-target behavior. "Preserve the
  `thinkingLevel`" is incomplete until it says what happens when one model has two.
- Require RED tests for the conflict case (same key, differing preserved value) and
  the pre-existing-target case, not only the happy path and the over-count path.

### For 04-review

- For any migration/dry-run helper, reproduce `migratable` against a config with
  (a) one key mapping to conflicting preserved values and (b) a pre-existing target
  block. If either silently loses data, it is a blocking correctness finding even
  though the printed diff looks right.
- Severity guide: a lossy claim is **high** when the helper can write, **medium**
  when it is read-only.

## Related solutions

- [`../testing/green-test-runner-is-not-a-type-check.md`](../testing/green-test-runner-is-not-a-type-check.md)
  — the other close-out learning; the compiler is also the migration checklist for
  the shared type this helper consumes.
- [`../workflow/frozen-decision-tables-drift-from-implemented-constants.md`](../workflow/frozen-decision-tables-drift-from-implemented-constants.md)
  — the same "the declared rule and the implemented rule disagree" family, at the
  decision-table level instead of the config-fold level.
- [`./one-freshness-predicate-reused-at-every-read-site.md`](./one-freshness-predicate-reused-at-every-read-site.md)
  — a single authoritative predicate is only safe when it is actually total.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-model-routing-conditional-review-closeout.md`
  (findings H1, M1; reviewers: correctness, maintainability).
- **Source plan:** `docs/plans/2026-10-06-model-routing-conditional-review-closeout-plan.md`
  (Unit 8 / G6).
- **Requirements:** `docs/brainstorms/2026-10-06-model-routing-conditional-review-remaining-gaps-requirements.md`.
- **Source files:** `extensions/ce-core/utils/role-migration.ts` (`:99`, `:122-129`,
  `:164-165`, `:182`), `scripts/migrate-roles.ts`, `tests/role-migration.test.ts`.
- **Reproduce:** `bun -e` with the two literals above, or `bun run migrate:roles`
  against the live `~/.pi/pi-pedstack/config.json` (`learn: high` → `max`).
- **Status:** defect confirmed at capture; the fix requires a design decision and is
  deferred to a `04-5-debug` / `03-work` re-entry because `04-review` and `05-learn`
  must not modify code.

## 🧠 Context Status

- **Health:** good — both loss axes are captured with exact reproduction; no source
  code changed in this stage.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/architecture/lossless-config-migration-must-key-on-every-preserved-field.md`,
  `extensions/ce-core/utils/role-migration.ts`, `scripts/migrate-roles.ts`,
  `tests/role-migration.test.ts`, `docs/reviews/2026-10-06-model-routing-conditional-review-closeout.md`
- **Recommendation for `06-docsync`:** document the dry-run migration helper's
  refusal semantics (conflicting `thinkingLevel`s and a pre-existing `models` block
  are `not_migratable`) in `README.md`, so operators know a refusal is expected
  rather than a bug.
