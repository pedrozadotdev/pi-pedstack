---
name: 02-plan
description: "Turn requirements into an execution-ready plan with TDD-gated implementation units. Use when a brainstorm artifact exists and is ready for planning."
disable-model-invocation: true
---

# Plan

Use this skill when requirements are ready to become an execution-ready plan.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

1. Load project rules (4 steps):
   - Load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/common/development-workflow.md` and `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/common/testing.md`
   - Detect project language via [language detection](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/language-detection.md)
   - Load matching language-specific rules (e.g., `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/typescript/`)
   - If frontend/browser concerns, also load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/web/` files
2. **Priority:** project-level `{repo-root}/rules/` overrides package defaults
3. Search `docs/brainstorms/` for relevant requirements first
4. Run solution search (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/solution-search.md`):
   - Extract keywords → `grep -rl "tags:.*keyword" docs/solutions/`
   - Read **frontmatter** only (first 15 lines) of matches → score by severity + tag relevance
   - Fully read top 3 candidates
5. Run documentation search (see [shared contextqmd docs instruction](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/contextqmd-docs.md)) using the `contextqmd` CLI as the primary tool.
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
5. **Source-driven check:** For each unit that involves framework/library APIs, verify the API or pattern against official documentation using the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/contextqmd-docs.md)). Check if the library is installed with `contextqmd libraries list --json`, search locally with `contextqmd docs search` (installing first if needed using `contextqmd libraries install <library>`), and read the relevant pages using `contextqmd docs get`. Add a note to the implementation unit detailing the documentation findings and citation sources.
6. If plan exists: use `plan_diff` `compare` → review with user → `patch`
7. If no plan: write new plan under `docs/plans/` using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/plan-template.md`
8. Structure work using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/implementation-unit-template.md`
9. Verify every unit follows TDD gates
10. **Strict Review (required)** — always execute. Read `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/ceo-review-mode.md` and run the full Strict Review flow (Premise Challenge, Dream State Mapping, Implementation Alternatives, Temporal Interrogation, Error and Rescue Map, Failure Modes Registry, Test Diagram). Update the plan artifact with any changes identified.
11. Invoke the **`multi_reviewer`** tool (required, execute this every time) with `stepName: "02-plan"` to review the plan artifact. This runs **after** the Strict Review so multi_reviewer inspects an already-reviewed plan.
12. Handoff to `03-work` via the standard pipeline handoff.

## Artifact output

- Plan: `docs/plans/<slug>.md`
- Use `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/plan-template.md` structure
- Implementation units follow `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/02-plan/references/implementation-unit-template.md`

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
