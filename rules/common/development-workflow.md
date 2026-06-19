# Development Workflow

> This file extends [common/git-workflow.md](./git-workflow.md) with the full feature development process that happens before git operations.

The Feature Implementation Workflow describes the development pipeline: research, planning, TDD, code review, and then committing to git.

## Universal Task Registration

> Applies to ALL phases of the development workflow (brainstorm through docsync).

Before executing any long chain of commands or multi-step work in any phase, the agent must:

1. **Register micro-tasks**: Use `todo_add` to explicitly log each intention, subtask, or verification step.
2. **Track progress**: Use `todo_list` throughout execution to check which tasks remain.
3. **Mark completion**: Use `todo_done` as each micro-task is completed.
4. **No premature handoff**: The agent must NOT execute `context_handoff` to proceed to the next stage if there are any pending (unfinished) tasks in the todo list.

This prevents context loss, dropped tasks, and premature stage handoffs across all workflow stages.

## Feature Implementation Workflow

0. **Research & Reuse** _(mandatory before any new implementation)_
   - **GitHub code search first:** Run `gh search repos` and `gh search code` to find existing implementations, templates, and patterns before writing anything new.
   - **Library docs second:** Use the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](../../skills/references/contextqmd-docs.md)) or primary vendor docs to confirm API behavior, package usage, and version-specific details before implementing.
   - **Exa only when the first two are insufficient:** Use Exa for broader web research or discovery after GitHub search and primary docs.
   - **Check package registries:** Search npm, PyPI, crates.io, and other registries before writing utility code. Prefer battle-tested libraries over hand-rolled solutions.
   - **Search for adaptable implementations:** Look for open-source projects that solve 80%+ of the problem and can be forked, ported, or wrapped.
   - Prefer adopting or porting a proven approach over writing net-new code when it meets the requirement.
   - **Source-driven trigger:** When implementation depends on a framework/library API, version-specific behavior, or a recommended pattern, verify against official documentation using `contextqmd` CLI (see [shared contextqmd docs instruction](../../skills/references/contextqmd-docs.md)) and cite key sources in the output. Pure logic, renaming, or in-project pattern reuse does not require external citation.

1. **Brainstorm & Plan First**
   - **No Direct-to-Implementation Bypass:** Skipping brainstorming and planning to go straight to coding is strictly prohibited. The full workflow (`01-brainstorm` → `02-plan` → `03-work` → `04-review` → `04-5-debug` → `05-learn` → `06-docsync`) must be followed.
   - Start with the **`01-brainstorm`** skill to discover requirements, followed by **`02-plan`** to define implementation units.
   - Generate required artifacts under `docs/brainstorms/` and `docs/plans/` before writing any codebase implementation.
   - Identify dependencies, edge cases, and risks.

2. **TDD Approach**
   - Use **tdd-guide** agent
   - Write tests first (RED)
   - Implement to pass tests (GREEN)
   - Refactor (IMPROVE)
   - Verify 80%+ coverage

3. **Code Review**
   - Use **code-reviewer** agent immediately after writing code
   - Address CRITICAL and HIGH issues
   - Fix MEDIUM issues when possible

4. **Commit & Push**
   - Detailed commit messages
   - Follow conventional commits format
   - See [git-workflow.md](./git-workflow.md) for commit message format and PR process

5. **Pre-Review Checks**
   - Verify all automated checks (CI/CD) are passing
   - Resolve any merge conflicts
   - Ensure branch is up to date with target branch
   - Only request review after these checks pass
