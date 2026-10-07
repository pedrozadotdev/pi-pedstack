---
name: 04-review
description: "Review code changes across five axes with evidence-first findings. Use after implementation is complete and before committing."
disable-model-invocation: true
---

# Review

Use this skill after implementation to review changes against the diff, plan, and prior learnings.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

1. Load project rules (4 steps):
   - Load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/common/code-review.md`
   - Detect language from changed files via [language detection](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/language-detection.md)
   - Load matching language-specific rules (e.g., `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/typescript/`)
   - If frontend/browser changes, also load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/web/` files
2. **Priority:** project-level `{repo-root}/rules/` overrides package defaults
3. Determine **diff scope** before selecting reviewers
4. Use **`review_router`** tool to select reviewer personas based on diff metadata. You (the model) must perform the initial reviews yourself by applying each persona's perspective and rules. Do NOT run `multi_reviewer` to delegate or orchestrate parallel reviewer subagents at this stage; instead, apply all reviewer personas yourself to compile the initial findings report, and call `multi_reviewer` (with `stepName: "04-review"`) only after this initial review and pass it to the sub-reviewers to audit and refine the findings.
5. Read relevant **plan** artifact when exists
6. Run solution search (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/solution-search.md`):
   - Call the **`solution_search`** tool with the change summary → read only the returned top 1–3 cards
   - Honor `status`: `ok` → apply guidance; `none` → no prior learnings (proceed); `degraded` → prior-ranked candidates only
7. Produce a compiled review findings report under `docs/reviews/` using the current plan filename without the `-plan` suffix, i.e., `docs/reviews/<topic>.md` (using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/findings-schema.md` as the baseline structured findings format and `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/review-findings-template.md` as the document layout).
8. **Review-only boundary:** do not modify source/tests/config to address findings in this stage. Verify findings, remove false positives from the report, and route confirmed findings back to `03-work` for fixes.

## Review discipline

Code review is **technical evaluation**, not social performance:

- **Verify before implementing** any suggestion
- **YAGNI check:** question features nothing uses
- **No performative agreement:** verify before concurring
- **Push back** with reasoning when findings are incorrect
- **Evidence before assertions:** cite specific code, not principles

## Handling findings

1. **Read** — complete all findings without reacting
2. **Verify** — check each against codebase reality
3. **Evaluate** — is it sound for THIS codebase?
4. **Classify** — keep confirmed actionable issues in the report; remove or explicitly reject incorrect findings
5. **Route** — confirmed findings go back to `03-work`; `04-review` never fixes implementation itself

## Workflow

1. **Load context**: consume latest handoff before any broad file reads — `context_handoff load` or read `.context/compound-engineering/handoffs/latest.md`. If found, use `activeFiles`, `artifacts.plan` as starting point. If not found, proceed normally.
2. Determine diff scope from branch or explicit target
3. Collect stats (files, insertions, deletions) → call `review_router`
4. Read matching plan artifact
5. Run solution search
6. Apply each reviewer persona from `review_router` yourself. You must perform the evaluation for each persona yourself rather than delegating the task to `multi_reviewer` or other subagents at this stage.
7. Merge all reviewer findings into a compiled review findings report (save to `docs/reviews/` using the current plan filename without the `-plan` suffix, i.e., `docs/reviews/<topic>.md`) following the structure in `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/review-findings-template.md`
8. Verify each finding against codebase and update the report
9. Run **`stage_gate`** for `04-review` and act on its `action`:
    - `accept` → do not run `multi_reviewer`; use the compiled report as the stage artifact.
    - `revise` → apply fixes and re-run `stage_gate`; no independent audit.
    - `review` → invoke **`multi_reviewer`** with `stepName: "04-review"` and `mode: "single"`, passing the report content as the `primaryOutput` parameter; inspect the returned findings, verify each against the codebase, apply the confirmed ones to the compiled report (or add the missing issues it surfaced), then re-run `stage_gate`.
    - `escalate` → stop the current stage loop. Do not continue with the current execution model, and do not invoke `/ped-reload` yourself; ask the operator to run `/ped-reload`. The persisted escalation makes Pedstack re-enter this same `04-review` stage under `models.sota` when routing is enforced (`routing.shadow: false`); in shadow mode the decision is recorded but not applied.
    A missing `action` (unknown stage or a tool regression) is treated as `none`; use the compiled report as the stage artifact.
    Use `mode: "deep"` only on an explicit user request. The tool auto-persists the structured findings JSON to `.context/compound-engineering/review-findings/<timestamp>-<stepName>.json` (gitignored) — including a `count: 0` sidecar for a clean review — and returns `findingsRelativePath`; use that sidecar path in the handoff's `artifacts.reviewFindings` field. The compiled `docs/reviews/*.md` report stays in `artifacts.review`. **Do NOT write your own `review-findings.json` to the repo root** — the tool already handles persistence inside `.context/`.
10. Finalize the report outcome:
    - Count the confirmed actionable findings using the canonical `- **Finding**:` entries.
    - Write `## Review Outcome` with `Status: findings` and the exact non-zero count when any confirmed finding remains.
    - Write `Status: clean` and `Findings: 0` only when the implementation has no confirmed unresolved findings.
    - Keep `artifacts.review` pointing to the compiled `docs/reviews/*.md` report. If `multi_reviewer` produced a structured sidecar, store that separately as `artifacts.reviewFindings`.
11. Save the handoff conditionally:
    - `Status: findings` → `nextStage: "03-work"`. Carry the review report path and concise highest-priority findings so work can fix them.
    - `Status: clean` → `nextStage: "05-learn"`.
    - Never route unresolved findings to `05-learn`. The runtime validates this transition against the report.

## Optional: QA Test Mode

After code review complete, offer browser QA:

> Code review done. Run browser QA?
>
> - **A) Done** — stop here
> - **B) Browser QA** — find visual/functional bugs
> - **C) QA + regression tests** — find bugs, fix, add tests

If B or C: read `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/qa-test-mode.md` and execute workflow.
After QA: include any confirmed findings in the report/handoff. Do not fix implementation in `04-review`; route findings to `03-work`.

## Handoff

Use the template in `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/handoff.md`.

- If the review report has confirmed findings, hand off to `03-work` to fix them.
- Only a clean report (`Status: clean`, `Findings: 0`) may hand off to `05-learn`.
- `/ped-debug` remains available for an operator-requested debugging session, but ordinary review findings use the `04-review → 03-work → 04-review` fix-forward loop.

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
