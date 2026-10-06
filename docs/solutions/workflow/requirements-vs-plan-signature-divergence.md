---
title: Detecting Requirement↔Plan Signature Divergence Before Implementation
category: workflow
severity: high
tags:
  - pedstack
  - requirements
  - plan
  - type-drift
  - contract-validation
  - strict-review
  - spec-conflict
  - jev
  - schema
  - validation
  - frozen-signature
  - reachability
  - field-set
  - recently-accessed-files
applies_when:
  - A plan freezes concrete type signatures derived from a requirements table
  - The requirements permit a wider type than the implementation validates
  - Local validation must never be stricter than an upstream/external contract
  - Running the 02-plan Strict Review or the 04-review requirements cross-check
  - A validation layer rejects input that the spec says is valid
  - A requirement names a set of inputs (e.g. two file lists) but the plan/implementation checks only one
  - The implementation adds parameters to a frozen signature without a recorded deviation
---

# Problem

An approved requirements document and a frozen plan signature disagreed about a field's type, and **only the code followed the plan** — the plan's own Strict Review never diffed its signature block against the requirements table.

Concretely, in the JEV headless runtime (`extensions/ce-core/jev/`):

- **Requirements R2** permitted `criteria` descriptions of type `string | object | array` for Noul/Choice/Score questions, and stated the explicit rule: *"Local validation uses the same bounds; no local limit is stricter than upstream."*
- **The plan's frozen signature block** narrowed those fields to `string` only: `JevChoiceQuestion.criteria: Record<string, string>`, `JevScoreQuestion.criteria: string[]`, `JevNoulQuestion.criteria?: { true?: string; false?: string }`.
- **The implementation** faithfully encoded the plan with TypeBox schemas, so a spec-valid request using object/array criteria was rejected:

```text
choice criteria value = object   → REJECTED invalid_request: … criteria.a: must be string
score  criteria entry = object   → REJECTED invalid_request: … criteria.0: must be string
noul   criteria.true  = object   → REJECTED invalid_request: … criteria.true: must be string
```

This is a *silent contract bug*: the caller is told the request is invalid and will blame their own payload, while the actual divergence is between two project documents.

# Context

- The plan was produced and "Strict Reviewed" in `02-plan`; the criteria types were copied into the plan's frozen signature block without a row-by-row comparison to R2.
- `03-work` implemented the plan and added tests **for the plan's types** (strings are well covered), so the test suite was green and high coverage did not reveal the gap.
- `04-review` found it only because a reviewer explicitly probed the built module with object/array criteria instead of only reading the diff. That is the intended review behavior, but it arrived one stage too late — the types were already frozen.
- The module is currently inert (not wired into `index.ts`), so the bug has not shipped; the risk is that consumer wiring (#4/#5) would inherit the narrowed contract.

# Solution

## 1. Widen the code to the requirement (preferred)

Match the upstream contract exactly, reusing the type that already exists for other free-form content:

```typescript
// validate.ts — reuse one union everywhere content is accepted
const JevContentSchema = Type.Union([
  Type.String(),
  Type.Object({}, { additionalProperties: true }),
  Type.Array(Type.Unknown()),
]);

Type.Object({
  type: Type.Literal("choice"),
  instructions: JevContentSchema,
  criteria: Type.Record(Type.String(), JevContentSchema), // was Type.String()
});
// likewise score: Type.Array(JevContentSchema), noul: JevContentSchema for true/false
```

Add positive tests for object and array criteria on **all three** question types (the string-only tests were the blind spot).

## 2. Or amend the requirement — never leave both

If strings-only is genuinely intended, edit R2 to say so and record the deviation. A spec and an implementation that disagree is worse than either choice, because the next reviewer cannot tell which one is authoritative.

## 3. Add a requirements↔signature diff gate

For every public field in the plan's frozen signature block, annotate the requirement id it derives from. Then the diff is mechanical:

```text
| Plan signature                              | Requirement | Match? |
| JevChoiceQuestion.criteria: Record<string,string> | R2 (string|object|array) | ❌  |
```

Run it at the end of `02-plan` and again before implementing in `03-work`.

# Why this works

- **The requirement is the contract; the plan is a hypothesis.** A plan may not narrow what the requirement permits, only choose how to satisfy it.
- **Coverage cannot catch a spec drift.** Tests written from the plan validate the plan, not the spec. Only a comparison against the source requirement can.
- **"No local limit stricter than upstream" is a testable invariant.** When a requirement makes that claim, it deserves a direct test: feed each documented input shape through validation and assert it is accepted.
- **Tracing every frozen signature to a requirement row turns a judgment call into a checklist** — which is exactly what a Strict Review is supposed to run.

# Prevention

- In `02-plan`, require a `Requirement` column (or footnote) on every type in the frozen-signature block; an unannotated public type is a review finding.
- Make "diff frozen signatures against the requirements table" an explicit Strict Review step, not an implicit one. The plan's Strict Review missed H1 precisely because it checked internal consistency only.
- When a requirement contains the word *"never stricter than upstream"* (or any compatibility guarantee), add a conformance test that exercises the full documented input matrix on day one.
- In `04-review`, treat "code matches plan" and "plan matches requirements" as **two** checks. A green suite plus the plan being self-consistent is not evidence for the second.
- Treat a spec-vs-code divergence as a blocker even when the module is inert, because it becomes real the moment a consumer wires in.

## Recurrence (2026-02-14): field-set reachability and contract-shape drift

The same class of divergence recurred one feature later, in the failure-triage review
([`2026-02-14-jev-failure-triage.md`](../../reviews/2026-02-14-jev-failure-triage.md)), proving the
prevention above was not applied even though the earlier card was in `docs/solutions/`.

| Finding | Status | Divergence | Why the diff looked green |
|---|---|---|---|
| M1 | Open decision | `TriageSource = "jev" \| "heuristic" \| "skipped"`, but the abstain path returns `null` before persisting, so `source: "skipped"` is **unreachable** — while the plan's failure registry says `Heuristic \| Abstains \| … \| Record (skipped)`. | Tests covered the declared union only by *presence*, never asserted each member is actually written. |
| M2 | Open decision | Requirement says `escalationSignal` is a versioned object (`v: 1`); `PersistedTriage.escalationSignal` is a `boolean`. | The plan never froze the field's shape, so code-vs-plan matched; the diff was compared to the plan, not the requirement. |
| M5 | Fixed in autofix | Plan Unit 5 says `details: {...event.details, triage: record}` (all 12 `PersistedTriage` fields); the handler exposed 3. | The handler test asserted only `.category`, so the narrowing was invisible. |

**Root cause:** the requirements↔plan diff checked *type names*, but not (a) **reachability of every union
member / enum value**, (b) **runtime shape of every persisted or returned field** (object vs primitive vs
versioned wrapper), or (c) **the field set of a record promised wholesale in the plan**.

**Detection added (extends the checklist above):**

- For every union/enum in a frozen signature, name the code path that writes each member. An unwritten
  member is a finding even if the type compiles and the branch exists (a `return` before the write path
  makes the member dead without a type error).
- For every persisted or returned field, cite the requirement line that defines its **shape**, not just its
  name. "Boolean now, versioned object when a downstream consumer arrives" is a divergence, not a detail.
- When the plan says a handler returns `record` / `…` wholesale, assert the full field set in a test, not a
  single representative field. A narrowed return is a silent contract cut.

This is the implementation-side twin of the type-narrowing variant above; the sibling signal-semantics
learning from the same review is [`../architecture/keep-degraded-fallbacks-out-of-primary-signal-state.md`](../architecture/keep-degraded-fallbacks-out-of-primary-signal-state.md).

## Recurrence (2026-10-06): input-set narrowing and unrecorded signature growth

The class recurred a third time in the handoff-readiness review
([`2026-10-06-semantic-handoff-readiness-validation.md`](../../reviews/2026-10-06-semantic-handoff-readiness-validation.md)),
again with the earlier prevention notes already sitting in `docs/solutions/`.

| Finding | Status | Divergence | Why the diff looked green |
|---|---|---|---|
| H1 | Open decision (autofixable) | Requirements: **`activeFiles` / `recentlyAccessedFiles`** entries that do not exist force `continuation_sufficiency` insufficient. Plan Unit 2 narrowed this to "a missing **active** file". `guard.ts` `computeReadiness` calls `missingActiveFiles(repoRoot, normalized, …)` and ignores `recentlyAccessedFiles`. | Every test supplied a missing *active* file; no test made recent-only files deleted. The plan's D-1..D-4 table does not record the narrowing. |
| L2 | Open decision | Plan's `## Frozen signatures` still shows `deriveOutcome(dimensions)`, `buildReadinessRequest(state)`, `readAnswers(result)`, exported `extractSection(...)`; the code adds optional `context`, `asked`, `forced` parameters and keeps `extractSection` private. | The signature block was never re-diffed against the implementation; the changes were justified in handoff prose, not the deviations table. |

**Root cause:** the two earlier detection rules were applied to *types and unions*, but not to
(a) **input sets named in a requirement** — "X **and** Y" must both be walked, and a plan that
checks only X is a narrowing; or (b) **added or removed parameters** on an otherwise matching
frozen signature. "The implementation matches the plan" stayed true; neither matched the requirement.

**Detection added (extends the checklist above):**

- When a requirement enumerates inputs with *and* / a list ("`activeFiles` / `recentlyAccessedFiles`"),
  write the loop over the **union** and add a test where the non-obvious member is the only one
  present. A narrowing to one member is a finding even if the other is usually populated.
- Diff the plan's frozen signatures against the final implementation **parameter-by-parameter**, not
  just type-by-type. Any added optional parameter, widened arity, or de-exported symbol belongs in
  the approved-deviations table with a reason.
- Treat the deviations table as the artifact that must be complete: a change justified only in a
  handoff or commit message is still an unrecorded divergence.

The read-site sibling signal from the same review is
[`../architecture/one-freshness-predicate-reused-at-every-read-site.md`](../architecture/one-freshness-predicate-reused-at-every-read-site.md).

## Recurrence (2026-10-06): behavior promised in docs but absent from code

The class recurred a fourth time in the docs-verification review
([`../../reviews/2026-10-06-runtime-source-driven-docs-verification.md`](../../reviews/2026-10-06-runtime-source-driven-docs-verification.md)).
This time the divergence was not a *type* mismatch but a **behavioral contract**
the requirements, plan, and docs all promised and the code never ran.

| Finding | Status | Divergence | Why the diff looked green |
|---|---|---|---|
| M1 | Open decision | R7 / Unit 4 / `AGENTS.md` / `CONTEXT.md` promise that open obligations carry across a plan rewrite by unit slug and that a waiver re-opens on hash change. `store.ts` exports `carryOverObligations`, but `guard.ts` never imports it — `evaluate` builds records from a fresh `classifyPlans` re-score. The function is imported **only** by `tests/docs-verification-store.test.ts`, so it is test-only dead code. A renamed-but-unchanged unit silently drops its waiver/satisfaction and is re-scored. | The guard test "a waived obligation re-opens when the unit hash changes" passes for the wrong reason: the fake Jev re-scores it `required`, not because carry-over ran. |
| M2 | Open decision | The plan and `AGENTS.md` scope the docs save hook to the `02-plan`/`03-work` **completion pairs**. `utils/docs-verification-wiring.ts` `run()` checks only `mode` and `DOCS_STAGES.has(currentStage)` and ignores `nextStage`; `tools/context-handoff.ts` calls it unconditionally before the completion gate. `isCompletionSave(currentStage, nextStage)` already exists in `stage-gate/store.ts` but is never consulted. An explicit same-stage checkpoint save can trigger a full evaluation and, in `enforce`, block. | The integration test always passes `nextStage: "04-review"`; no test saves with `nextStage === currentStage`. |

**Root cause, extended:** a documented behavior that lives only in prose (a
requirement row, a plan unit, `AGENTS.md`) is invisible to the type system and to
a green suite. "Code matches the plan" and "the plan is self-consistent" both
stay true while the promised behavior is unreachable. Dead helper code is a
particularly strong tell: an exported function whose only import is a test is
evidence that the intended call site was never wired.

**Detection added (extends the rules above):**

- For every behavior stated in requirements/plan/docs, name the production call
  site that implements it. If the only import of the implementing function is a
  test, the behavior is a divergence, not an implementation choice.
- Do not accept a passing test as proof the path ran: assert the *effect* (the
  waiver stays open / the carry-over field is merged), not just the surfaced
  verdict, so a re-score cannot impersonate a carry-over.
- When a plan names a predicate that scopes a hook (e.g. `isCompletionSave`),
  require the hook to call it; a hook that re-implements a broader condition
  inline is a divergence even when it is a superset.

## Downstream Impact

### For 02-plan

- Annotate each frozen type with its requirement id and diff the types table against the requirements before handoff.
- If a requirement permits a union, plan the schema and the positive tests for **every** branch of the union.

### For 04-review

- Do not stop at "the diff matches the plan". Open the requirements and check each public contract type against it.
- Probe the built module with the spec's documented input shapes, not just the tests' shapes. The object/array criteria rejection was invisible to code reading.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-commandcode-headless-runtime.md` (Finding H1)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T14-37-52-895Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-05-jev-commandcode-headless-runtime-requirements.md` (R2, limits table)
- **Plan:** `docs/plans/2026-10-05-jev-commandcode-headless-runtime.md` (frozen signature block)
- **Source files:** `extensions/ce-core/jev/types.ts`, `extensions/ce-core/jev/validate.ts`
- **Recurrence source files:** `extensions/ce-core/handoff-readiness/guard.ts`, `docs/plans/2026-10-06-semantic-handoff-readiness-validation.md`
- **Status:** finding identified in review; fix deferred to `04-5-debug` or consumer wiring (#4/#5). Accepted deviations from the same review are recorded in [`../tooling/fallow-findings-for-inert-module-barrel.md`](../tooling/fallow-findings-for-inert-module-barrel.md). The 2026-10-06 recurrence is autofixable (union the two file lists; add D-5..D-8 rows).

## 🧠 Context Status

- **Health:** good — the module is inert and the finding is documented, so advancement to `06-docsync` is not blocked.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/jev/types.ts`, `extensions/ce-core/jev/validate.ts`, `docs/reviews/2026-10-05-jev-commandcode-headless-runtime.md`
- **Recommendation for `06-docsync`:** link this card from the requirements/plan follow-up list; do not let consumer wiring (#4/#5) start until H1 is either fixed or R2 is formally amended.
