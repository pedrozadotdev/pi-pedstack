---
name: 02-plan
description: "Turn requirements into an execution-ready plan with TDD-gated implementation units. Use when a brainstorm artifact exists and is ready for planning."
disable-model-invocation: true
---

# Plan

Use this skill when requirements are ready to become an execution-ready plan.

See [shared pipeline instructions](../references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

1. Load project rules (4 steps):
   - Load `rules/common/development-workflow.md` and `rules/common/testing.md`
   - Detect project language via [language detection](../references/language-detection.md)
   - Load matching language-specific rules (e.g., `rules/typescript/`)
   - If frontend/browser concerns, also load `rules/web/` files
2. **Priority:** project-level `{repo-root}/rules/` overrides package defaults
3. Search `docs/brainstorms/` for relevant requirements first
4. Run solution search (see `references/solution-search.md`):
   - Extract keywords → `grep -rl "tags:.*keyword" docs/solutions/`
   - Read **frontmatter** only (first 15 lines) of matches → score by severity + tag relevance
   - Fully read top 3 candidates
5. Run documentation search (see [shared contextqmd docs instruction](../references/contextqmd-docs.md)) using the `contextqmd` CLI as the primary tool.
6. Write plan to `docs/plans/`
7. If plan exists, use **`plan_diff`** to compare and patch incrementally
8. End by recommending `03-work`

## Hard gates — TDD enforcement

Every unit follows **RED → GREEN → REFACTOR**:

**TDD violation rejection criteria** — reject and revise if any unit:
- Implements code before failing test
- Lacks RED step verification
- Lacks GREEN step verification
- Skips verification
- Uses placeholders or unstated assumptions

## Planning flow

1. **Load context**: consume latest handoff before any broad file reads — `context_handoff load` or read `.context/compound-engineering/handoffs/latest.md`. If found, use `activeFiles` and `blocker` as starting point. If not found, proceed normally (new project).
2. Read relevant brainstorm from `docs/brainstorms/`
3. Run solution search (keywords → grep frontmatter → read top 3)
4. Gather repository context
5. **Source-driven check:** For each unit that involves framework/library APIs, verify the API or pattern against official documentation using the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](../references/contextqmd-docs.md)). Check if the library is installed with `contextqmd libraries list --json`, search locally with `contextqmd docs search` (installing first if needed using `contextqmd libraries install <library>`), and read the relevant pages using `contextqmd docs get`. Add a note to the implementation unit detailing the documentation findings and citation sources.
6. If plan exists: use `plan_diff` `compare` → review with user → `patch`
6. If no plan: write new plan under `docs/plans/` using `references/plan-template.md`
7. Structure work using `references/implementation-unit-template.md`
8. Verify every unit follows TDD gates
9. Invoke the **`multi_reviewer`** tool (required, execute this every time) with `stepName: "02-plan"` to review the plan artifact.

## Optional: CEO Review

After invoking the **`multi_reviewer`** tool (required, execute this every time) with `stepName: "02-plan"` to review the plan artifact, offer strategic review:

> Plan ready. How to review?
> - **A) Just go** — trust the plan
> - **B) CEO Review** — challenge premises, dream-state mapping
> - **C) Strict Review** — CEO + error maps, failure modes, test diagrams

If B or C: read `references/ceo-review-mode.md` and execute review flow.
After review: update plan artifact, then handoff to `03-work`.

## Artifact output

- Plan: `docs/plans/<slug>.md`
- Use `references/plan-template.md` structure
- Implementation units follow `references/implementation-unit-template.md`

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](../references/pipeline-config.md).
