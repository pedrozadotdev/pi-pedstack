---
title: Handling fallow Findings for an Inert, Unwired Module Barrel
category: tooling
severity: low
tags:
  - fallow
  - dead-code
  - re-export
  - barrel
  - inert-module
  - unused-type
  - pedstack
  - ci-gate
  - accepted-deviation
  - jev
applies_when:
  - Running `fallow audit` on a branch that adds a module before its consumer wiring
  - The module re-exports types from a barrel (`index.ts`) with no production importer yet
  - Deciding whether an `unused-type` / `unused-export` finding is actionable
  - Recording an accepted quality-gate deviation in a plan or review
---

# Problem

`fallow audit --base HEAD` returned **fail** on a branch whose only change was a self-contained, deliberately unwired module. 27 findings were `unused-type` re-exports from the new `index.ts` barrel (`JevAnswer`, `JevContent`, `JevProcessRunner`, …), plus 3 complexity findings. None of the 27 indicated dead code: the module is intentionally inert pending consumer wiring (#4/#5), so nothing imports the barrel yet and Fallow cannot see the future consumer.

The `.fallow` directory in the repo is only a churn cache (`.fallow/churn.bin`); it is **not** a config and there is **no CI gate** — `.github/workflows/test.yml` runs only `bun test`. Treating this `fail` as a merge blocker would be a false positive; ignoring it silently would hide the 3 genuine complexity findings that share the same output.

# Context

- The plan chose "Approach A: minimal internal module, no Pi surface" and explicitly left `extensions/ce-core/index.ts` and `package.json` byte-identical — so the module has no production importer by design.
- The requirements anticipated exactly this: *"No Fallow/CI dead-code gate exists in this repo today … No suppression pragma is added. If such a gate is introduced before #4/#5 land, the consumer import will already satisfy it."*
- Because there is no gate, the `fail` is an ad-hoc local signal. The risk is a future contributor misreading the cached verdict or adding a blanket suppression that would also mask real dead code.

# Solution

## 1. Split the verdict by cause before acting

Read the findings, not just the pass/fail:

- 27 × `unused-type` with `is_re_export: true` from `index.ts` → **expected** for an inert barrel; defer.
- 3 × complexity (`decide` CC 12, `assertKnownQuestionTypes` CC 11, `validateProbabilities` CC 10) → **actionable**; track as refactor findings.

A single `fail` can carry both a false positive and a real issue; resolve them separately.

## 2. Record the accepted deviation, don't suppress it

No `// fallow-ignore` pragma, no config exclusion. Record the acceptance where the next reader will look (requirement/plan/review) with the condition that lifts it:

```text
Accepted deviation: fallow audit --base HEAD reports 27 unused-type re-exports
from extensions/ce-core/jev/index.ts. Expected while the module is unwired;
resolves automatically when the first consumer imports the barrel (#4/#5).
Re-check fallow audit at wiring time. No suppression added.
```

## 3. Re-check at the moment the consumer lands

The findings are self-clearing once production code imports the barrel. Make "re-run `fallow audit` after wiring" a checkbox on the consumer issue, so the acceptance is time-boxed rather than permanent.

## Other accepted deviations from the same review

| Deviation | Evidence | Handling |
| --- | --- | --- |
| LOC target exceeded | plan said `≤ ~700 LOC`, actual `1 317` (`+88 %`); each file still `< 800` | Accept — validation completeness prioritized; amend the plan target so a future reader does not treat 700 as a hard gate. |
| Live `cmd`/CommandCode sample not run | `JEV_LIVE=1` test is opt-in and was skipped | Accept explicitly for this branch; the requirement to record pass/not-run *before* consumer wiring (#4/#5) still stands. |

# Why this works

- **Fallow is syntactic and has no type information**, so a type that is only re-exported looks unused until an importer exists. This is a known property of dead-code analysis on barrels, not a bug.
- **An inert module is a legitimate delivery shape** (YAGNI: build the internal capability now, wire the surface later), so the "unused" finding is correct-but-not-actionable for this window.
- **Time-boxing the acceptance at the wiring issue** prevents the deviation from outliving its justification — the failure mode of "accept and forget".
- **Separating the finding classes** keeps the real complexity signal from being swallowed by the expected noise.

# Prevention

- When a plan intentionally ships an unwired module, state up front that `fallow audit` will report barrel re-exports and mark them as expected-until-wired.
- Do not add suppression pragmas to satisfy a gate that does not exist; suppressing types now would let real dead code through after wiring.
- If a repo adds a Fallow/CI dead-code gate later, wire the barrel **before** enabling the gate, or scope the gate to changed files that have importers.
- Keep the acceptance in the plan/review and put the unconditional re-check on the consumer issue.

## Downstream Impact

### For 02-plan

- Note expected `fallow` noise for planned-inert modules and separate it from real findings in the completion report.
- If a numeric LOC target is specified, label it as a soft guide unless it is enforced by a gate.

### For 04-review

- When `fallow audit` fails, break the verdict down by category before assigning severity; do not echo `fail` as a blanket blocker.
- Confirm whether a gate is actually wired in CI (`.github/workflows/`) before treating a local `fail` as merge-blocking.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-commandcode-headless-runtime.md` (Findings L1, L2; live-sample decision)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T14-37-52-895Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-05-jev-commandcode-headless-runtime-requirements.md` (Fallow acceptance note)
- **Evidence:** `.github/workflows/test.yml` (runs only `bun test`), `.fallow/churn.bin` (cache, not config)
- **Status:** accepted/deferred by design; related findings captured in [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md) and [`../integration/decoding-child-process-streams-with-stringdecoder.md`](../integration/decoding-child-process-streams-with-stringdecoder.md).

## 🧠 Context Status

- **Health:** good — deviations are documented and time-boxed to consumer wiring (#4/#5).
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/jev/index.ts`, `.github/workflows/test.yml`, `docs/brainstorms/2026-10-05-jev-commandcode-headless-runtime-requirements.md`
- **Recommendation for `06-docsync`:** carry the "re-run `fallow audit` after wiring" checkbox and the LOC-target amendment into the plan/requirements follow-ups.
