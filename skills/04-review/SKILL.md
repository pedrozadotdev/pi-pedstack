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
   - Extract keywords → `grep -rl "tags:.*keyword" docs/solutions/`
   - Read **frontmatter** only (first 15 lines) of matches → score by severity + tag relevance
   - Fully read top 3 candidates
7. Produce a compiled review findings report under `docs/reviews/` using the current plan filename without the `-plan` suffix, i.e., `docs/reviews/<topic>.md` (using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/findings-schema.md` as the baseline structured findings format and `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/review-findings-template.md` as the document layout).
8. **Autofixable findings:** apply and re-review (max 3 iterations)
9. **Task Tracking:** Before initiating the work in this stage, register your micro-tasks using `todo_add`. Continually check your list using `todo_list` and mark items complete with `todo_done`. **CRITICAL:** You must not execute `context_handoff` to the next stage if there are pending tasks on your list.

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
4. **Act** — fix confirmed issues, push back on incorrect ones
5. **Test** — verify each fix individually, no regressions

## Workflow

1. **Load context**: consume latest handoff before any broad file reads — `context_handoff load` or read `.context/compound-engineering/handoffs/latest.md`. If found, use `activeFiles`, `artifacts.plan` as starting point. If not found, proceed normally.
2. Determine diff scope from branch or explicit target
3. Collect stats (files, insertions, deletions) → call `review_router`
4. Read matching plan artifact
5. Run solution search
6. Apply each reviewer persona from `review_router` yourself. You must perform the evaluation for each persona yourself rather than delegating the task to `multi_reviewer` or other subagents at this stage.
7. Merge all reviewer findings into a compiled review findings report (save to `docs/reviews/` using the current plan filename without the `-plan` suffix, i.e., `docs/reviews/<topic>.md`) following the structure in `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/review-findings-template.md`
8. Verify each finding against codebase and update the report
9. Invoke the **`multi_reviewer`** tool (required, execute this every time) with `stepName: "04-review"` to review the compiled review findings report, passing the report content as the `primaryOutput` parameter, and use the sub-reviewer feedback to refine the report or find missing issues
10. Apply autofixes, re-run tests, re-review if needed

## Optional: QA Test Mode

After code review complete, offer browser QA:

> Code review done. Run browser QA?
>
> - **A) Done** — stop here
> - **B) Browser QA** — find visual/functional bugs
> - **C) QA + regression tests** — find bugs, fix, add tests

If B or C: read `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/qa-test-mode.md` and execute workflow.
After QA: include findings in handoff, note fix commits/test files.

## Handoff

Handoff to `04-5-debug` (using the template in `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/04-review/references/handoff.md`) for user verification and routing.

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
