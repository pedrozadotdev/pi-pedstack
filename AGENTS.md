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
| `/ped-next [prompt]` | Auto-resolve and advance to the next pipeline stage¹ |
| `/ped-reload` | Restart the current stage from a fresh context, re-applying skill config |
| `/ped-fix-issues <#1,#2,...>` | Prompt-inject GitHub issue context into 01-brainstorm |
| `/ped-debug <prompt>` | Enter 04-5-debug on demand with gating (warns if before 04-review). Prompt is required. |

> ¹ **Auto-advance:** `/ped-next` is automatically queued by the extension after every successful `context_handoff save`, except for the two gated transitions (`02-plan→03-work` and `04-review→05-learn`) which prompt for confirmation. The authorization cache is per-session — once approved, the dialog is skipped for the remainder of the session. In print mode (`-p`), gated transitions auto-advance silently.

## Workflow Discipline

- **STRICT PIPELINE SEQUENCE:** The step-by-step workflow (`01-brainstorm` → `02-plan` → `03-work` → `04-review` → `05-learn` → `06-docsync`) is strictly required. No stage can be bypassed or combined.
- **NO DIRECT-TO-IMPLEMENTATION BYPASS:** Do NOT skip the initial stages (Brainstorming/Planning) to go straight to code implementation or file editing. Start every new feature, bug fix, or task with the `01-brainstorm` skill.
- **AUTO-ADVANCE ON SAVE:** 4 of 6 transitions auto-advance; 2 require user authorization (see footnote ¹).
- **STAGE CAPABILITY GUARD:** The ce-core extension blocks `write`/`edit` calls whose target path falls outside the active stage's capability matrix. `unknown` paths and absent stages fail open; `.context/` workflow state is never writable via `write`/`edit`. `bash` calls are additionally classified by a deterministic shell-effect classifier, with unresolvable commands routed to the local Jev semantic layer (shadow by default). Set `PEDSTACK_DISABLE_GUARD=1` to bypass both guards.
- **STAGE COMPLETION GATE:** `context_handoff save` re-runs the stage's deterministic artifact predicates on every cross-stage completion save (blocking in both `shadow` and `enforce`), and in `enforce` also requires a fresh, enforcing `accept` record from the `stage_gate` tool. `PEDSTACK_STAGE_GATE=off|shadow|enforce` (default `shadow`) is read once at init.
- **🐴 PONYTALL DISCIPLINE:** Before planning or writing any code, apply the 6-rung YAGNI ladder below. The system prompt injects this discipline into `02-plan`, `03-work`, `04-review`, and `04-5-debug` — but you must internalize it yourself.

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
                 # Default: 01→02→03→04→05→06 (04-5-debug entered via /ped-debug)
  references/    # Shared templates and schemas
  rules/         # Coding standards (common + language-specific)
extensions/      # Optional Pi extensions (ce-core: tools, commands, prompt injection)
  ce-core/utils/ # Pure helpers: auto-advance, active-stage store, capability matrix, bash command-effect guard, solution ranking
  ce-core/tools/ # Pi tools + pure helper modules (output filters, failure triage)
  ce-core/stage-gate/ # Stage artifact rubrics, evidence, record store, save-side completion guard
  ce-core/injection-screen/ # Two-phase tool_result provenance screen (shadow-first)
  ce-core/jev/   # Typed transport + runtime for CommandCode headless decisions (consumed by solution ranking, the stage gate, the bash stage guard, and failure triage; no direct Pi tool surface)
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
| `stage_gate` | Score a stage artifact: deterministic checks + bounded Jev scoring → one verdict |
| `multi_reviewer` | Orchestrate parallel reviewer subagents |
| `checklist_add` / `checklist_show` / `checklist_del` | Persistent task tracking with handoff gating (bulk add via `descriptions[]`) |
| `solution_search` | Rank `docs/solutions/**` cards for a query via Jev semantic ranking with a deterministic fallback (`mode: recall` / `overlap`) |

**Handoff gating:** `context_handoff save` blocks cross-stage saves when the checklist is non-empty. The model must complete or delete all pending tasks before advancing to the next stage. Use `checklist_add` (accepts `descriptions: string[]`) when discovering tasks from SKILL.md, rules, or references to avoid dropped tasks.

**Stage guard:** `extensions/ce-core/utils/capability-matrix.ts` is a pure module that classifies a repo-relative path into one of 11 `PathClass` values and decides whether the active stage may write it. `extensions/ce-core/utils/active-stage.ts` tracks the live stage in memory and persists it to `.context/compound-engineering/active-stage.json` (gated on an existing `context-state.json`). The `pi.on("tool_call")` handler in `extensions/ce-core/index.ts` blocks forbidden `write`/`edit` calls before execution and fails open on any error.

**Bash stage guard:** `extensions/ce-core/utils/command-effect.ts` is a pure quote-aware shell-effect classifier that extracts literal targets and reuses `evaluateWrite`. `semantic-stage-guard.ts` owns policy/verdict mapping and builds the bounded Jev questions; `stage-guard-runtime.ts` orchestrates dedupe/serialization with all I/O injected; `guard-log.ts` appends redacted shadow verdicts to `.context/compound-engineering/jev-stage-guard.jsonl`. Modes are read once from `PEDSTACK_JEV_STAGE_GUARD` (`off | shadow | enforce`, invalid fails safe to `shadow`); `PEDSTACK_JEV_STAGE_GUARD_FAILCLOSED=1` opts into blocking on a degraded semantic layer. The deterministic verdict short-circuits before any Jev call.

**Failure triage:** a fourth `pi.on("tool_result")` handler (`failure-triage` + `failure-triage-runner` + `triage-store`) annotates a failed `test`/`typecheck`/`lint`/`build` bash result during `03-work` or `04-5-debug` with a bounded advisory TRIAGE block and persists a record under `.context/compound-engineering/triage/`. It is additive only: never returns `isError`, never mutates code, never changes exit status, and never bypasses stop-the-line. Jev outages degrade to a keyword heuristic, and any internal error fails open (the result is left unchanged).

**Stage completion gate:** `extensions/ce-core/stage-gate/` scores a stage's produced artifact (via the `stage_gate` tool) and persists content-hashed records under `.context/compound-engineering/stage-gates/`. `context_handoff save` re-runs the deterministic floor on every cross-stage completion save and consults the record for the semantic verdict. Deterministic failures block in both `shadow` and `enforce`; `PEDSTACK_STAGE_GATE` (default `shadow`) is resolved once at init in `extensions/ce-core/stage-gate/store.ts`.

**Solution ranking:** `extensions/ce-core/utils/solution-ranking.ts` exposes `rankSolutions()`, the single entry point used by the `solution_search` tool, by stage auto-injection (`02-plan`, `04-review`, `04-5-debug`, `05-learn`) and by `05-learn` overlap detection. It ships shadow-first: `solutionRanking.shadow` defaults to `true`, so auto-injection computes and logs but stays inert until enforcement is enabled. A Jev outage returns the deterministic `prior` ranking (`status: "degraded"`), never an empty list. Auto-injection is composed inside the single existing `before_agent_start` handler (`extensions/ce-core/utils/solution-wiring.ts`).

**Injection screen:** `extensions/ce-core/injection-screen/` runs a two-phase `tool_result` screen around the bash/read size filters. Phase 1 (registered first) classifies provenance deterministically (`http`, `gh-issue`, `gh-pr`, `gh-api`, `external-path`) and, for untrusted sources only, asks Jev one bounded `noul` question; phase 2 (registered last) prepends a fixed warning wrapper around the final content only in `enforce`+`flagged` mode. It never blocks and never rewrites (the wrapper surrounds verbatim content). `PEDSTACK_INJECTION_SCREEN=off|shadow|enforce` (default `shadow`) is resolved once at init; missing/invalid values fall back to `shadow` with a one-time warning and never silently resolve to `off`. Jev outages are `degraded`, an unwrapped verdict is a `wrap-miss`; both pass content through unchanged. Sanitized metadata-only records go to `.context/compound-engineering/injection-screens.jsonl` (at most 128 verdicts per turn).

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
