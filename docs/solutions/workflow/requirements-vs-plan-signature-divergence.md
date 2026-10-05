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
applies_when:
  - A plan freezes concrete type signatures derived from a requirements table
  - The requirements permit a wider type than the implementation validates
  - Local validation must never be stricter than an upstream/external contract
  - Running the 02-plan Strict Review or the 04-review requirements cross-check
  - A validation layer rejects input that the spec says is valid
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
- **Status:** finding identified in review; fix deferred to `04-5-debug` or consumer wiring (#4/#5). Accepted deviations from the same review are recorded in [`../tooling/fallow-findings-for-inert-module-barrel.md`](../tooling/fallow-findings-for-inert-module-barrel.md).

## 🧠 Context Status

- **Health:** good — the module is inert and the finding is documented, so advancement to `06-docsync` is not blocked.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/jev/types.ts`, `extensions/ce-core/jev/validate.ts`, `docs/reviews/2026-10-05-jev-commandcode-headless-runtime.md`
- **Recommendation for `06-docsync`:** link this card from the requirements/plan follow-up list; do not let consumer wiring (#4/#5) start until H1 is either fixed or R2 is formally amended.
