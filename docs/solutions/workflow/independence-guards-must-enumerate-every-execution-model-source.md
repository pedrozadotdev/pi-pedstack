---
title: Independence Guards Must Enumerate Every Execution-Model Source, Not Just Role Defaults
category: workflow
severity: high
tags:
  - pedstack
  - multi-reviewer
  - review-independence
  - self-review
  - guard-coverage
  - model-routing
  - plan-gap
  - stage-override
  - requirements-traceability
  - comparison-set
applies_when:
  - A guard enforces "A must not coincide with B" (self-review, self-approval, self-escalation)
  - The guarded value can be set by more than one config source (role default, per-stage override, env, CLI)
  - A plan freezes a guard's comparison set derived from a requirement's intent
  - Running the 02-plan guard design or the 04-review requirements cross-check
  - A reviewer can still execute on the same model that produced the artifact under review
---

# Problem

The `multi_reviewer` review-independence guard was implemented **exactly to spec** and still
failed to deliver its requirement. `resolveReviewRole` refuses `models.review.model` when it
equals an *execution role* model — but only the role defaults:

```typescript
// extensions/ce-core/tools/multi-reviewer.ts — resolveReviewRole
const executionModels = [
  config?.models?.default?.model,
  config?.models?.sota?.model,
].filter((model): model is string => typeof model === "string");

if (executionModels.includes(review.model)) { /* ignore, warn */ }
```

The comparison set omitted the **per-stage execution override** `config[stageKey].model`. At
`04-review`, `getConfigKeyForSkill("04-review") === "review"`, so `stageConfig = config.review`,
and `switchStageConfig` → `switchModel(stageConfig)` applies `config.review.model` to the stage
*before* reviewer selection. A config with `review.model = "X"` **and**
`models.review.model = "X"` therefore spawns a reviewer running `X` to review a stage that was
executed on `X` — the precise self-review the guard exists to prevent.

This was a **plan gap, not an implementation deviation**: Unit 7's spec narrowed the guard to
role models, and the code matched the spec. Requirement #3 ("`review` is never an execution
target") was broader than the guard that was supposed to enforce it.

# Context

- The plan froze `models.review` as a *role* and the guard was written against the role block
  (`models.default`, `models.sota`), the same block that the resolver itself reads. The guard
  and the resolver shared an implicit assumption: "execution models come from the roles".
- That assumption stopped being true the moment a per-stage override (`config[stageKey].model`)
  was introduced in the same change. Task-level overrides and role-level defaults are two
  independent writers of "the model that will execute this stage".
- The gap was invisible to the test suite because the tests (and the plan) exercised the role
  path. The guard read as correct in isolation, and "code matches plan" was green.
- Severity is high even though no user was affected yet: the requirement is an integrity
  guarantee, and the failure mode is *silent* — the guard logs nothing because it sees no
  collision.

# Solution

**Make the guard's comparison set the union of every writer of the guarded value — and keep it
derived from one source of truth.**

1. **Enumerate writers, not roles.** Collect every path that can set the execution model for the
   target stage, then compare against the collected set:

   ```typescript
   const executionModels = [
     config?.models?.default?.model,        // role default
     config?.models?.sota?.model,           // role escalation
     (config as any)?.[configKey]?.model,   // per-stage execution override
   ].filter((m): m is string => typeof m === "string");
   ```

2. **Fail closed on collision (ignore the role), not open.** Keep the existing behavior of
   returning `undefined` plus a `console.warn` that names the colliding model and the source
   that supplied it, so the suppressed reviewer is observable.

3. **Add the collision test at the winning precedence level.** `review.model = X` +
   `models.review.model = X` must assert "role ignored / no self-review reviewer". Test the
   *highest-precedence* writer, not just the role block, or the test reproduces the same blind
   spot as the guard.

4. **If the guard reads from a config value, reuse the same resolver the executor uses.** If
   `switchModel`/`resolveStageRouting` already owns "what model will run for this stage", call
   that resolver instead of re-deriving the answer from a subset of the config. One owner, one
   comparison set.

5. **Record the scope extension in the plan/ADR.** Widening a guard beyond its written spec is
   a requirement-level change; capture it where the next reader will look, otherwise the next
   review reports the same gap.

# Why this works

- **A guard is only as complete as its comparison set.** "Review must not run the same model as
  execution" is a statement about *all* writers of the execution model, not about the block the
  author happened to read. Omitting a writer silently disables the guard for that writer.
- **Precedence order is where guards break.** Role defaults are the fallback; overrides are the
  common case once they exist. A guard validated only against the fallback path passes every
  test and fails in production configs.
- **"Code matches the plan" cannot detect a plan gap.** The implementation review checked
  consistency with Unit 7 and was correct; only a requirements-level cross-check (does the guard
  cover requirement #3's intent?) exposed the hole. These are two different checks.
- **Fail-closed + observable warn** preserves the security/integrity property while leaving a
  trace when a legitimate config is deliberately suppressed.

# Prevention

- **Derive the guard's comparison set from the same resolver that applies the value.** Any
  time you hand-write a list of "possible sources", treat it as a code smell: ask which function
  owns the value and call it.
- **For every guard, write an enumeration table in the plan:** `value | source | can set it?`.
  Include role defaults, per-stage overrides, env overrides, and CLI/TUI overrides. An empty
  row is an unguarded writer.
- **In `02-plan`, when a requirement says "never X", diff the guard's comparison set against the
  requirement, not against the unit spec.** Add a `Requirement` column to guard designs the same
  way frozen signatures get one.
- **In `04-review`, re-derive the guarded value from the requirements.** If the stage can be
  executed by a model the guard never considered, the guard is a finding even though the diff
  matches the plan.
- **Test at the winning-precedence source.** A guard test that sets only the fallback value
  proves the guard works when nothing overrides it — i.e. the case that rarely matters.

## Downstream Impact

### For 02-plan

- Add an enumeration table to every unit that designs a guard: list every writer of the guarded
  value and cite the requirement the guard enforces. Missing writer = missing coverage.
- When introducing a new writer (e.g. a per-stage override) in the same plan as a guard, treat
  the guard's comparison set as a unit that must be updated by the new writer's PR. Cross-link
  the two units.

### For 04-review

- Do not accept "the guard matches its spec" as closure. Open the requirement the guard serves
  and enumerate the runtime paths that set the guarded value; flag any unguarded writer.
- Probe the guard with the *highest-precedence* config (override first, role fallback second);
  that is the config real users ship.
- A silent guard failure (no warn, no error) should be treated as higher severity than a noisy
  one, because there is no signal to detect the regression later.

## Related solutions

**Overlap check:** no High-overlap card exists. Closest existing cards are Moderate/Low and
cover different root causes, so this was created new rather than updated.

- [`./requirements-vs-plan-signature-divergence.md`](./requirements-vs-plan-signature-divergence.md)
  — Moderate: the sibling "spec disagrees with requirement" failure, but on *type shape* rather
  than *guard coverage*. Both are caught only by a requirements-level cross-check, and both
  recommend a `Requirement` column on the frozen artifact.
- [`./agentic-sub-reviewers-need-tool-prohibition-and-line-evidence.md`](./agentic-sub-reviewers-need-tool-prohibition-and-line-evidence.md)
  — Moderate: same `multi_reviewer` surface and review-workflow concerns, but about the
  sub-reviewer *output contract*, not which model runs it.
- [`../tooling/fallow-findings-for-inert-module-barrel.md`](../tooling/fallow-findings-for-inert-module-barrel.md)
  — Low: same #6 review's fallow-gate findings; see its Recurrence section for the
  frozen-signature suppression exception.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-model-roles-default-review-sota-jev-routing.md`
  (Low finding "independence guard does not cover the per-stage execution override"; plan gap,
  not an implementation deviation)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T02-32-09-861Z-04-review-to-05-learn.md`
  (invalidated assumption: the independence guard only compares role models)
- **Requirements:** `docs/brainstorms/2026-10-06-model-roles-default-review-sota-jev-routing.md`
  (requirement #3 — `review` is never an execution target)
- **Plan:** `docs/plans/2026-10-06-model-roles-default-review-sota-jev-routing-plan.md` (Unit 2, Unit 7)
- **Source files:** `extensions/ce-core/tools/multi-reviewer.ts` (`resolveReviewRole`, ~line 333),
  `extensions/ce-core/commands/pedstack.ts` (`switchStageConfig` → `switchModel`),
  `extensions/ce-core/utils/model-routing.ts`
- **Status:** finding identified in `04-review`; fix deferred to `04-5-debug` or a `03-work`
  re-entry because `04-review` may not modify source. Frozen signature preserved.

## 🧠 Context Status

- **Health:** good — the gap is documented and the module is not user-reachable in this window.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/tools/multi-reviewer.ts`,
  `extensions/ce-core/commands/pedstack.ts`, `extensions/ce-core/utils/model-routing.ts`,
  `docs/reviews/2026-10-06-model-roles-default-review-sota-jev-routing.md`
- **Recommendation for `06-docsync`:** link this card from the #6 plan's Unit 7 follow-up and
  note the guard-coverage checklist in the review-workflow docs.
