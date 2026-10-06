---
title: Agentic Sub-Reviewers Need a Tool Prohibition and path:line Evidence
category: workflow
severity: medium
tags:
  - multi-reviewer
  - subagent
  - sub-reviewer
  - prompt-injection
  - path-line
  - evidence
  - stage-gate
  - review-workflow
  - json-parsing
  - pi-extension
  - pedstack
applies_when:
  - Calling multi_reviewer (or any subagent) and parsing its output as structured findings
  - A downstream gate requires findings to cite file and line (path:line)
  - A sub-reviewer returns prose or calls tools instead of returning a parseable verdict
  - Wiring an agentic reviewer into an automated review pipeline
---

# Problem

`multi_reviewer` orchestrates reviewer subagents over the primary output and
returns findings that the `04-review` stage persists and the stage gate scores.
Two behaviours of the sub-reviewer are easy to miss when you treat it as a
pure function:

1. **It is agentic by default.** Unless explicitly told *not* to, the
   sub-reviewer can call tools, and it answers in prose — there is no parseable
   JSON verdict to extract. A pipeline that assumes a JSON envelope will either
   crash or silently capture nothing.
2. **Evidence needs `path:line`.** The `04-review` stage gate's
   `findings_reference_file_line` predicate requires each finding to reference a
   concrete file and line. Prose findings that name only a file (or a symbol)
   fail the gate even though the review is substantively correct.

Both surfaced in the #14 review: the sub-reviewer returned prose findings that
had to be re-extracted into the persisted finding set
(`.context/compound-engineering/review-findings/2026-10-05T21-10-37-705Z-04-review.json`),
and the extracted evidence had to be anchored with `path:line` for the gate to
accept the artifact.

# Context

`multi_reviewer` is invoked inside `04-review` and its output feeds
`context_handoff save` via the stage completion gate. The reviewer personas are
chosen by `review_router`; the sub-reviewer model is an agentic model with tool
access, so its default response shape is conversational. The pipeline's contract,
however, is structured: a model-facing review report plus a persisted findings
JSON whose entries must carry file/line evidence so the gate predicate can pass.

Related: [`../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`](./stage-artifact-completion-gate-shadow-first-rubrics.md)
documents the gate predicate (`findings_reference_file_line`) and why real
artifacts must be probed; this card covers providing the sub-reviewer the
instructions needed to satisfy it.

# Solution

**Constrain the sub-reviewer's output shape and require line-anchored evidence in
the same prompt.**

- **Tell the sub-reviewer not to call tools** (or to stay in a
  reasoning-and-answer mode). Removing tool access/encouragement makes the
  response a single deterministic text/JSON answer rather than a conversation
  with side effects.
- **Ask for a machine-extractable finding list** — explicitly request
  `path:line` for every finding and name the required fields
  (severity, evidence, recommended action). Do not rely on the sub-reviewer to
  infer the schema.
- **Re-extract and anchor evidence before persisting.** Treat the sub-reviewer
  prose as input to a normalization step that maps each finding to
  `file:line`; assert `count === findings.length` on the persisted JSON.
- **Keep the gate's requirement visible in the prompt.** If a predicate such as
  `findings_reference_file_line` exists, quote it in the reviewer instructions
  so the sub-reviewer produces gate-passing output the first time.

# Why this works

- **Agentic ≠ deterministic.** A subagent with tool access and a free-form prompt
  is a conversation, not a function. The caller owns the output contract, so the
  caller must state it.
- **A gate predicate is a prompt requirement.** Automated gates turn prose
  conventions (cite file and line) into hard failures. Surfacing the predicate in
  the reviewer prompt moves the failure from the gate back to the prompt, where
  it is cheap to fix.
- **Normalize at the boundary.** Even a well-prompted subagent can return slight
  shape variance; a single extraction/anchoring step keeps the persisted findings
  schema stable and the `count === findings.length` invariant checkable.

# Prevention

- **Prompt the sub-reviewer to not call tools** and to return the exact finding
  schema (with `path:line`).
- **Assert the persisted findings count** equals the number of findings in the
  report; a mismatch means extraction dropped something.
- **In `04-review`, check the gate predicate before saving handoff** — run the
  deterministic floor mentally (or via `stage_gate`) so a missing `path:line`
  is caught in-stage, not at save time.
- **Reuse the same prompt contract** for any future agentic reviewer so the
  pipeline has one extraction path.

## Downstream Impact

### For 02-plan

- When planning a unit that calls `multi_reviewer` or any subagent, include the
  output contract (no tool calls, required `path:line`) and a normalization step
  with a count assertion.
- Note any stage-gate predicate the review output must satisfy in the unit's
  verification section.

### For 04-review

- Before saving the stage handoff, verify every finding references `file:line`;
  the `findings_reference_file_line` gate will otherwise block or shadow-warn.
- Treat the sub-reviewer response as prose input to extraction, never as
  already-structured output.

## Related solutions

**Overlap check:** no High-overlap card exists (new artifact, distinct root cause).
Closest existing cards: `stage-artifact-completion-gate-shadow-first-rubrics` (Moderate —
same `findings_reference_file_line` gate predicate) and
`child-process-event-listener-mock-for-pi-extension-tests` (Low — same `multi_reviewer`
tooling, different concern). Created new rather than updated.

- [`./stage-artifact-completion-gate-shadow-first-rubrics.md`](./stage-artifact-completion-gate-shadow-first-rubrics.md)
  — defines the gate predicate and the "probe with real artifacts" practice that
  makes `path:line` a hard requirement.
- [`../testing/child-process-event-listener-mock-for-pi-extension-tests.md`](../testing/child-process-event-listener-mock-for-pi-extension-tests.md)
  — the test-harness side of the same review tooling (`multi_reviewer` mocks and
  timeout control).

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
  (Audit Feedback section; handoff key learning #5)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T21-12-11-357Z-04-review-to-05-learn.md`
- **Source artifacts:**
  - `.context/compound-engineering/review-findings/2026-10-05T21-10-37-705Z-04-review.json` (persisted findings; `count === findings.length === 9`)
  - `extensions/ce-core/tools/multi-reviewer.ts`
  - `extensions/ce-core/stage-gate/` (the `findings_reference_file_line` predicate)
- **Status:** documented during `05-learn`; no code change required for the
  learning itself.

## 🧠 Context Status

- **Health:** good — the workflow learning is captured; no source change is
  associated with it.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/workflow/agentic-sub-reviewers-need-tool-prohibition-and-line-evidence.md`,
  `extensions/ce-core/tools/multi-reviewer.ts`,
  `extensions/ce-core/stage-gate/evidence.ts`,
  `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
- **Recommendation for `06-docsync`:** note the sub-reviewer output contract and
  the `path:line` gate coupling in the review-workflow docs.
