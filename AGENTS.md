# AGENTS.md — pi-pedstack

## Project Overview

pi-pedstack is a Pi-native engineering workflow layer: brainstorm → plan → work → review → learn.
Built with TypeScript, tested with Bun test runner, published to npm as `pi-pedstack`.

## Tech Stack

- Runtime: Bun
- Language: TypeScript (strict)
- Test: `bun test`

## Key Commands

```bash
bun test              # Run all tests
```

## Architecture

```
skills/          # 8 pipeline skills (00-next, 01-brainstorm, 02-plan, 03-work, 04-review, 04-5-debug, 05-learn, 06-docsync)
  references/    # Shared templates and schemas
  rules/         # Coding standards (common + language-specific)
extensions/      # Optional Pi extensions
tests/           # Test files
docs/            # Documentation and assets
```

## Code Style

- TypeScript strict mode
- Functions < 50 lines, files < 800 lines
- No deep nesting (> 4 levels)
- No `console.log` or debug statements in production code
- No hardcoded secrets or credentials
- Explicit error handling (no silent catches)

## Review Guidelines

### Priority Levels

Codex reviews all PRs using the following priority levels:

| Priority | Label | Meaning | Action |
|----------|-------|------|------|
| **P0** | 🔴 Blocker | Security vulnerabilities, logical errors, risk of data loss | Must fix, blocks merge |
| **P1** | 🟡 Important | Missing tests, improper error handling, performance issues | Strongly recommended to fix |
| **P2** | 🟢 Suggestion | Code style, readability, naming optimization | Address at discretion |

### P0 — Must Label (Block)

- Security vulnerabilities: XSS, SQL injection, auth bypass, hardcoded secrets
- Logical errors: off-by-one, unhandled null/undefined, race conditions
- Data loss risk: delete operations without confirmation, irreversible changes without backup mechanisms
- Breaking changes not marked as `BREAKING CHANGE`
- Introduction of framework API usage without source-driven verification
- `bun test` fails
- Violation of stop-the-line rules: continuing to add features after finding a failure

### P1 — Recommended Label (Important)

- New features missing corresponding tests
- Test coverage below 80%
- Missing or incorrect error handling (empty catch blocks, swallowed exceptions)
- Functions exceeding 50 lines or files exceeding 800 lines
- Nesting level exceeding 4 levels
- Missing JSDoc/TSDoc comments for public APIs
- Changes affecting skill registration or triggers under `skills/` but corresponding tests not updated

### P2 — Optional Label (Suggestion)

- Naming is not clear enough or does not follow project conventions
- Code readability improvements (extracting variables, simplifying conditional expressions)
- Performance micro-optimizations (reducing unnecessary copies, caching computation results)
- Comments can be more precise

### Should Not Label

- TODO comments (unless introducing risk)
- Missing documentation for internal/private functions
- Requesting more tests when adequate tests already exist
- Historical code issues unrelated to this change
- Purely subjective style preferences (with no functional impact)

### Review Language

- Review comments must be written in **English**
- Code examples and quotes should remain in English
- Technical terms should remain in their original English form (e.g. TDD, RED/GREEN/REFACTOR, checkpoint)

### Review Behavior Requirements

- Every comment must **reference specific code lines**
- Suggestions must provide a **concrete fix**, not just describe the problem
- Pay special attention to TypeScript projects: type safety, strict mode compliance, usage of `any` types
- Pay special attention to the `skills/` directory: skill registration format, trigger condition accuracy, SKILL.md frontmatter completeness
- Pay special attention to the `rules/` directory: enforceability and clarity of rules

## Commit Convention

This project follows Conventional Commits v1.0:

```
feat(skill): add new pipeline stage
fix(checkpoint): resolve resume-from-checkpoint edge case
docs(readme): update installation instructions
chore(deps): upgrade dependencies
```
