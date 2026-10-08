# Development Workflow

> This file extends [common/git-workflow.md](./git-workflow.md) with the full feature development process that happens before git operations.

The Feature Implementation Workflow describes the development pipeline: research, planning, TDD, code review, and then committing to git.

## Feature Implementation Workflow

0. **Research & Reuse** _(mandatory before any new implementation)_
   - **GitHub code search first:** Run `gh search repos` and `gh search code` to find existing implementations, templates, and patterns before writing anything new.
   - **Library docs second:** Consult official vendor/library documentation for the installed version to confirm API behavior, package usage, and version-specific details before implementing.
   - **Exa only when the first two are insufficient:** Use Exa for broader web research or discovery after GitHub search and primary docs.
   - **Check package registries:** Search npm, PyPI, crates.io, and other registries before writing utility code. Prefer battle-tested libraries over hand-rolled solutions.
   - **Search for adaptable implementations:** Look for open-source projects that solve 80%+ of the problem and can be forked, ported, or wrapped.
   - Prefer adopting or porting a proven approach over writing net-new code when it meets the requirement.
   - **Source-driven trigger:** For external framework/library APIs or version-specific patterns, verify against official documentation with available tools and cite authoritative source URLs or stable documentation paths. Pure logic, renaming, or in-project pattern reuse does not require external citation. Record compact evidence as `docs-verified: PACKAGE@VERSION DOC_REF`; the runtime trigger at `02-plan`/`03-work` tracks obligations until satisfied or waived.

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
