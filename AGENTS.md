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

| Command | Description |
|---------|-------------|
| `/ped-start <prompt>` | Start a new Pedstack workflow, launching 01-brainstorm |
| `/ped-next [prompt]` | Auto-resolve and advance to the next pipeline stage |
| `/ped-reload` | Restart the current stage from a fresh context, re-applying skill config |
| `/ped-fix-issues <#1,#2,...>` | Prompt-inject GitHub issue context into 01-brainstorm |

## Workflow Discipline

- **STRICT PIPELINE SEQUENCE:** The step-by-step workflow (`01-brainstorm` → `02-plan` → `03-work` → `04-review` → `04-5-debug` → `05-learn` → `06-docsync`) is strictly required. No stage can be bypassed or combined.
- **NO DIRECT-TO-IMPLEMENTATION BYPASS:** Do NOT skip the initial stages (Brainstorming/Planning) to go straight to code implementation or file editing. Start every new feature, bug fix, or task with the `01-brainstorm` skill.
- **🐴 PONYTALL DISCIPLINE:** Before planning or writing any code, apply the 6-rung YAGNI ladder below. The system prompt injects this discipline into `02-plan`, `03-work`, and `04-review` — but you must internalize it yourself.

## 🐴 Ponytail Discipline (YAGNI / Lazy Senior Dev Mode)

The best code is the code never written. Before writing or planning any code, stop at the first rung that holds:

| # | Question | Action |
|---|----------|--------|
| 1 | Does this need to be built at all? | YAGNI — drop the requirement if possible |
| 2 | Does the standard library already do this? | Use it |
| 3 | Does a native platform feature cover it? | Use it |
| 4 | Does an already-installed dependency solve it? | Use it |
| 5 | Can this be one line? | Make it one line |
| 6 | Only then | Write the minimum code that works |

### Enforcement rules

- **No unrequested abstractions** — interfaces, factories, or base classes not in the requirements are noise. Delete them.
- **No new dependencies if avoidable** — prefer `node:fs` over `fs-extra`, `fetch` over `axios`, built-in test runner over Jest.
- **Deletion over addition** — remove lines over adding them. Every line shipped is a line maintained.
- **Boring over clever** — simple loops > functional pipelines, switch > reflection, plain objects > metaprogramming.
- **Mark with `ponytail:` comments** — annotate intentional simplifications so reviewers know the shortcut was deliberate.
- **Do NOT compromise on security, input validation, or error handling** — Ponytail targets code volume, not correctness.

### Handoff blockers

Only set a blocker in `context_handoff save` when an actual problem blocks progress. Leave the `blocker` field empty/undefined when nothing blocks advancement — never write "N/A", "None", or any placeholder. An absent blocker lets `/ped-next` advance to the next stage.

## Architecture

```
skills/          # 7 pipeline skills (01-brainstorm, 02-plan, 03-work, 04-review, 04-5-debug, 05-learn, 06-docsync)
  references/    # Shared templates and schemas
  rules/         # Coding standards (common + language-specific)
extensions/      # Optional Pi extensions (ce-core: tools, commands, prompt injection)
tests/           # Test files
docs/            # Documentation, brainstorms, plans, reviews, solutions
```

### CE Core Extension (Tools)

| Tool | Purpose |
|------|---------|
| `artifact_helper` | Resolve and create standard CE artifact paths |
| `workflow_state` | Scan repo for workflow artifacts |
| `review_router` | Recommend reviewer personas from diff metadata |
| `session_checkpoint` | Save/load/resume execution checkpoints |
| `task_splitter` | Analyze parallel-safe execution groups |
| `brainstorm_dialog` | Multi-round interactive brainstorming |
| `plan_diff` | Compare/update plan units |
| `session_history` | Record and query skill execution history |
| `pattern_extractor` | Extract recurring patterns from artifacts |
| `context_handoff` | Save/load/validate cross-stage handoffs |
| `multi_reviewer` | Orchestrate parallel reviewer subagents |
| `checklist_add` / `checklist_show` / `checklist_del` | Persistent task tracking with handoff gating (bulk add via `descriptions[]`) |

**Handoff gating:** `context_handoff save` blocks cross-stage saves when the checklist is non-empty. The model must complete or delete all pending tasks before advancing to the next stage. Use `checklist_add` (accepts `descriptions: string[]`) when discovering tasks from SKILL.md, rules, or references to avoid dropped tasks.

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
