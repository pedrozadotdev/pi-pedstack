# Strict Review Mode (required for 02-plan)

`02-plan` **always** runs a Strict Review of the plan artifact before handing off to `03-work`. There is no "Just go" / "CEO Review" / "Strict Review" choice — the full Strict Review is a mandatory step in the planning flow. It runs **before** the `multi_reviewer` tool so that the multi-reviewer pass inspects an already stress-tested plan.

The review has two layers:

1. **CEO Review** (steps 1–4 below) — challenge the premise, map the dream state, propose alternatives, interrogate the implementation timeline.
2. **Strict Review additions** (steps 5–7 below) — extend the CEO Review with an error/rescue map, a failure-modes registry, and a test diagram.

All seven steps run on every plan. Do not skip any.

## When to run

After the plan artifact is written to `docs/plans/`, before invoking the `multi_reviewer` tool. The full flow is:

1. Run steps 1–7 below against the current plan artifact.
2. Update the plan artifact with any changes identified.
3. Note the review mode (Strict Review) and key decisions in the plan.
4. Proceed to the `multi_reviewer` tool with `stepName: "02-plan"`.

## 1. Premise Challenge

Re-examine the plan's assumptions:

- Is this the right problem to solve? Could a different framing yield a simpler solution?
- What is the actual user/business outcome? Is the plan the most direct path?
- What happens if we do nothing? Real pain or hypothetical?

Present findings as premises the user must agree with. Ask for confirmation directly in your response.

## 2. Dream State Mapping

Describe the ideal end state 12 months from now. Does this plan move toward it?

```
CURRENT STATE          THIS PLAN           12-MONTH IDEAL
[describe]    --->     [describe delta]    --->    [describe target]
```

## 3. Implementation Alternatives (MANDATORY)

Produce 2-3 distinct approaches. This is NOT optional.

For each approach:

```
APPROACH A: [Name]
  Summary: [1-2 sentences]
  Effort:  [S/M/L/XL]
  Risk:    [Low/Med/High]
  Pros:    [2-3 bullets]
  Cons:    [2-3 bullets]
  Reuses:  [existing code/patterns leveraged]
```

Rules:

- At least 2 approaches required.
- One must be "minimal viable" (fewest files, smallest diff).
- One must be "ideal architecture" (best long-term trajectory).
- Recommend one and explain why.

## 4. Temporal Interrogation

Think ahead to implementation. What decisions should be resolved NOW?

```
HOUR 1 (foundations):     What does the implementer need to know?
HOUR 2-3 (core logic):   What ambiguities will they hit?
HOUR 4-5 (integration):  What will surprise them?
HOUR 6+ (polish/tests):  What will they wish they'd planned for?
```

Surface these as questions NOW, not "figure it out later."

## 5. Error and Rescue Map

For every new method/codepath that can fail:

```
METHOD/CODEPATH    | WHAT CAN GO WRONG     | EXCEPTION CLASS
-------------------|-----------------------|-----------------
ExampleService#call| API timeout           | TimeoutError
                   | Malformed response    | JSONParseError

EXCEPTION CLASS    | RESCUED? | RESCUE ACTION      | USER SEES
-------------------|----------|--------------------|------------------
TimeoutError       | Y        | Retry 2x, then raise | "Temporarily unavailable"
JSONParseError     | N (GAP)  | -                    | 500 error (BAD)
```

## 6. Failure Modes Registry

```
CODEPATH | FAILURE MODE   | RESCUED? | TEST? | USER SEES?  | LOGGED?
---------|----------------|----------|-------|-------------|--------
```

Any row with RESCUED=N, TEST=N, USER SEES=Silent is a **CRITICAL GAP**.

## 7. Test Diagram

Map every new thing the plan introduces:

- New UX flows
- New data flows
- New codepaths
- New error/rescue paths

For each: what test covers it? Happy path? Failure path? Edge case?

## Cognitive patterns

These shape your perspective throughout the review. Don't enumerate them; internalize them:

1. **Classification instinct** — categorize by reversibility x magnitude (Bezos)
2. **Inversion reflex** — for every "how do we win?" also ask "what would make us fail?" (Munger)
3. **Focus as subtraction** — primary value-add is what to NOT do (Jobs)
4. **Speed calibration** — fast is default. Only slow down for irreversible + high-magnitude (Bezos)
5. **Proxy skepticism** — are our metrics still serving users? (Bezos Day 1)
6. **Temporal depth** — think in 5-10 year arcs, regret minimization (Bezos)
7. **Courage accumulation** — confidence comes FROM making hard decisions, not before (Horowitz)
8. **Leverage obsession** — find inputs where small effort creates massive output (Altman)
9. **Edge case paranoia** — what if the name is 47 chars? Zero results? Network fails?
10. **Subtraction default** — "as little design as possible" (Rams)

## Handoff

After Strict Review:

1. Update the plan artifact with any changes identified during the review.
2. Note the review mode (`Strict Review`) and the key decisions/changes in the plan.
3. Proceed to the `multi_reviewer` tool with `stepName: "02-plan"` (this is the **next** step in `02-plan` SKILL.md).
4. After `multi_reviewer` completes, proceed to the `03-work` handoff via `references/handoff.md`.
