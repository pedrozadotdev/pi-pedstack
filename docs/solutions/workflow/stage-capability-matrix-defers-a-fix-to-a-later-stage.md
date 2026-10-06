---
title: A Phase-Separated Write Guard Defers Part of a Fix to a Later Stage — Schedule the Unit by Stage
category: workflow
severity: medium
tags:
  - pedstack
  - capability-matrix
  - phase-separated-stages
  - deferred-unit
  - cross-stage-handoff
  - handoff-open-decision
  - plan-scheduling
  - stage-guard
  - deliverable-ownership
  - grep-verification
  - workflow-state
  - pi-extension
applies_when:
  - A plan's remediation units write to paths owned by different pipeline stages
  - A deterministic stage capability matrix blocks `write`/`edit` for a path class in the working stage
  - A deliverable must land in `docs/solutions/**` (`05-learn`) or `docs/**` (`06-docsync`) but the fix is coded in `03-work`
  - A review reports an item "carried forward" with no stage owner
  - Writing a cross-stage `context_handoff save` for a fix that spans stages
  - Reviewing a plan whose units are all scheduled in one stage
---

# Problem

When writes are phase-separated by a deterministic capability matrix, a **single fix can span
multiple pipeline stages**. A plan that schedules every unit in the working stage (`03-work`)
will contain units that *cannot execute* there: the stage guard blocks the target path class
deterministically, not advisably.

The symptom is a deliverable that never lands. In the drift-guard follow-up
([#33](https://github.com/pedrozadotdev/pi-pedstack/issues/33)) the fix had two halves:

| Unit | Target path | Path class | Writable in |
|---|---|---|---|
| Unit 1 — amend the frozen matrix + deviation-phrase guard | `tests/drift-combine.test.ts` | `tests` | `03-work` |
| Unit 1c — append the `## Resolution (2026-10-06)` decision record | `docs/solutions/workflow/frozen-spec-…md` | `solution` | `05-learn` only |

The brainstorm had scheduled Unit 1c in `03-work`. It could not run: `docs/solutions/**` is the
`solution` class, which `03-work`'s capability set (`tests, source, config, deps, unknown`) does
not contain. Without an explicit stage owner, the deliverable becomes an untracked "carried
forward" note that a later session may never execute.

# Context

The `pi-pedstack` ce-core extension enforces a capability matrix
(`extensions/ce-core/utils/capability-matrix.ts`) that classifies a repo-relative path into one
of 11 classes and blocks a `write`/`edit` whose class the active stage may not write. The
mechanism is documented in
[`deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](./deterministic-path-classification-guard-for-stage-scoped-tool-calls.md).
That card covers *building* the guard; this card covers the **planning consequence** of living
with it.

The 02-plan Strict Review surfaced the mismatch as a "plan correction": the brainstorm's Unit 1
placed the resolution note in `03-work`, but the note is a `solution`-class write. The plan
re-scheduled it as **Unit 1c, executed in `05-learn`**, added a "capability-matrix constraint"
section, and flagged it in the `02-plan → 03-work` handoff as an `openDecision`/`activeRule`. The
04-review confirmed it and listed it under "Open items carried forward", explicitly noting it was
*"not a review finding — a scheduled deliverable blocked from `03-work`/`04-review` by the
capability matrix."*

# Solution

## 1. Classify every unit's target path before assigning a stage

For each implementation unit, resolve its target path to a `PathClass` and check it against the
stage you are about to schedule it in:

```ts
// plan-time check, not runtime hope
evaluateWrite("03-work", repoRoot, "docs/solutions/workflow/card.md").allow // false -> wrong stage
evaluateWrite("05-learn", repoRoot, "docs/solutions/workflow/card.md").allow // true  -> owning stage
```

Any unit that fails its stage's check is split: one unit per owning stage.

## 2. Split the unit and mark the deferral explicitly

Do not silently drop or defer the blocked half. Give it its own unit id (`1c`), name the owning
stage, and record *why* it is deferred so a reader cannot mistake it for a forgotten task:

```md
### Unit 1c — Solution-card resolution note *(executed in `05-learn`, not `03-work`)*

**Why deferred.** `docs/solutions/**` is class `solution` — `03-work`'s capability set is
`tests, source, config, deps, unknown`. A `write`/`edit` there is blocked by the stage guard.
```

## 3. Carry the deferred unit in the handoff as an open decision

A stage boundary is where deferred work is lost. The handoff for the working stage must carry the
deferred unit explicitly (as an `openDecision`/`activeRule` or a `## 05-learn must do` section),
naming the exact file and the exact edit. The plan's `## Open decisions` row and the review's
"Open items carried forward" are the same fact stated twice on purpose.

## 4. Verify in the later stage with a deterministic probe

Do not trust the handoff prose. When the later stage runs, assert the deliverable with a
command whose result is unambiguous:

```bash
grep -n "## Resolution (2026-10-06)" docs/solutions/workflow/frozen-spec-…md  # -> match
```

A grep/`rg` on the exact heading (or a test) is the completion evidence; "I appended it" is not.

## 5. Do not attempt the blocked write in the working stage

The guard blocks it and records nothing useful. The correct response is to route the unit, not to
retry, and not to work around the guard. The `grep` verification belongs to the owning stage.

# Why this works

- **The block is deterministic, not a suggestion.** A `solution`-class path is never writable from
  `03-work`, so a unit assigned there is dead on arrival. Splitting at plan time converts a runtime
  block into a scheduled, owned handoff.
- **Stage boundaries are delivery boundaries.** A unit that crosses a boundary without an explicit
  owner is a deliverable that depends on someone noticing. Naming the owner in the plan *and* the
  handoff removes that dependency.
- **A grep probe is a falsifiable completion check.** The owning stage proves the artifact exists
  by reading the exact expected line, not by re-asserting intent.

# Prevention

- **In `02-plan`, add a "path class vs stage capability" pass.** For every unit, verify
  `evaluateWrite(owningStage, repoRoot, targetPath).allow`; split units that span stages.
- **Give every deferred unit an id and an owning stage.** `1c · 05-learn` is recoverable; "docs
  note" is not.
- **Put the deferred unit in both the plan's `Open decisions` and the stage handoff.** Redundancy
  across the two artifacts is the point — each is read at a different time by a different context.
- **In `04-review`, flag any "carried forward" item with no stage owner** and any unit whose target
  path class the owning stage cannot write.
- **In the owning stage, close the loop with a grep/test probe**, then delete the deferral from the
  checklist so it does not outlive the work.

## Downstream Impact

### For `02-plan`

- Add a stage-ownership column to the implementation-units table and to the temporal/error maps:
  for each unit, record the owned `PathClass` and the stage allowed to write it.
- Treat a unit that fails `evaluateWrite(owningStage, repoRoot, targetPath)` as a plan defect, not an execution
  surprise; split it and mark the deferral with a "Why deferred" note.
- Carry the deferred unit in the `nextStage` handoff as an `openDecision`/`activeRule` with the
  exact path and edit.

### For `04-review`

- Flag any deliverable reported as "carried forward" that does not name the owning stage — an
  unowned deferral is the failure mode this card documents.
- Flag a plan or handoff where a `docs/solutions/**` or `docs/**` deliverable is scheduled in
  `03-work`/`04-review`; those classes are `05-learn`/`06-docsync` writable only.
- Confirm the owning stage has a deterministic probe for the deferred artifact.

## Overlap check

- `deterministic-path-classification-guard-for-stage-scoped-tool-calls.md` — **moderate** overlap:
  same subsystem (the stage guard) but a different angle (planning consequence vs guard
  mechanism) → new card, cross-linked.
- `frozen-spec-can-contradict-its-own-normative-pseudocode.md` — **low** overlap: spec
  self-consistency versus cross-stage scheduling → distinct card, cross-linked.
- `tool-based-task-tracking-with-handoff-gating.md` — **low** overlap: checklist gating versus
  stage-capability deferral → distinct card.

## Related solutions

- [`./deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](./deterministic-path-classification-guard-for-stage-scoped-tool-calls.md)
  — the guard mechanism (pure classifier + matrix + thin handler) whose phase separation forces
  the deferral this card schedules.
- [`./frozen-spec-can-contradict-its-own-normative-pseudocode.md`](./frozen-spec-can-contradict-its-own-normative-pseudocode.md)
  — the spec conflict that Unit 1/1c resolved; the `05-learn` append is the concrete deferred unit.
- [`./tool-based-task-tracking-with-handoff-gating.md`](./tool-based-task-tracking-with-handoff-gating.md)
  — the checklist/handoff gate that keeps a deferred task from being forgotten across a stage save.

## Provenance

- **Issue:** [#33 — Drift guard follow-ups from #8](https://github.com/pedrozadotdev/pi-pedstack/issues/33)
- **Plan:** `docs/plans/2026-10-06-drift-guard-follow-ups-issue-33-plan.md`
  ("Capability-matrix constraint (plan correction)", Unit 1c, "Strict Review → Premise Challenge")
- **Requirements:** `docs/brainstorms/2026-10-06-drift-guard-follow-ups-issue-33-requirements.md`
- **Review:** `docs/reviews/2026-10-06-drift-guard-follow-ups-issue-33.md` ("Open items carried forward")
- **Source files:**
  - `extensions/ce-core/utils/capability-matrix.ts` — `classifyPath` / `evaluateWrite`
  - `docs/solutions/workflow/frozen-spec-can-contradict-its-own-normative-pseudocode.md` — Unit 1c target
  - `tests/drift-combine.test.ts` — Unit 1 target (the stage-separated sibling unit)
- **Status:** captured in `05-learn` from the #33 follow-up review; plan Unit 1c delivered.

## 🧠 Context Status

- **Health:** good — learning captured from the #33 fix-forward; no source was modified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  `docs/solutions/workflow/stage-capability-matrix-defers-a-fix-to-a-later-stage.md`,
  `docs/solutions/workflow/frozen-spec-can-contradict-its-own-normative-pseudocode.md`,
  `docs/plans/2026-10-06-drift-guard-follow-ups-issue-33-plan.md`,
  `docs/reviews/2026-10-06-drift-guard-follow-ups-issue-33.md`,
  `extensions/ce-core/utils/capability-matrix.ts`
- **Recommendation for `06-docsync`:** link this card from the plan/stage-discipline docs and the
  capability-matrix guard card so future plans run the path-class-vs-stage check up front.
