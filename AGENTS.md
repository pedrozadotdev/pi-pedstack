# AGENTS.md — pi-pedstack

## Project Overview

pi-pedstack is a Pi-native engineering workflow layer: brainstorm → plan → work → review → learn.
Built with TypeScript, tested with Bun test runner, published to npm as `pi-pedstack`.

## Tech Stack

- Runtime: Bun
- Language: TypeScript (strict)
- Test: `bun test` (transpile-only — it does not type-check)
- Type check: `bun x tsc --noEmit`

## Key Commands

```bash
bun test              # Run all tests
bun x tsc --noEmit    # Type-check (strict mode); bun test alone does NOT type-check
```

| Command | Description |
|---------|-------------|
| `/ped-start <prompt>` | Start a new Pedstack workflow, launching 01-brainstorm |
| `/ped-next [prompt]` | Auto-resolve and advance to the next pipeline stage¹ |
| `/ped-reload` | Restart the current stage from a fresh context, re-applying skill config |
| `/ped-fix-issues <#1,#2,...>` | Prompt-inject GitHub issue context into 01-brainstorm |
| `/ped-debug <prompt>` | Enter 04-5-debug on demand with gating (warns if before 04-review). Prompt is required. |

> ¹ **Auto-advance:** `/ped-next` is automatically queued after a successful handoff. `04-review→03-work` is the automatic fix-forward route when confirmed findings remain. `04-review→05-learn` is valid only for a validated clean review (`Status: clean`, `Findings: 0`) and is confirmation-gated; `02-plan→03-work` is also confirmation-gated. The authorization cache is per-session.

## Workflow Discipline

- **STRICT PIPELINE SEQUENCE:** The workflow is `01-brainstorm → 02-plan → 03-work → 04-review`; any confirmed review findings must loop `04-review → 03-work → 04-review` until the review is clean, then continue `05-learn → 06-docsync`. No stage may bypass unresolved findings.
- **NO DIRECT-TO-IMPLEMENTATION BYPASS:** Do NOT skip the initial stages (Brainstorming/Planning) to go straight to code implementation or file editing. Start every new feature, bug fix, or task with the `01-brainstorm` skill.
- **AUTO-ADVANCE ON SAVE:** 4 of 6 transitions auto-advance; 2 require user authorization (see footnote ¹).
- **STAGE CAPABILITY GUARD:** The ce-core extension blocks `write`/`edit` calls whose target path falls outside the active stage's capability matrix. `unknown` paths and absent stages fail open for ordinary project files; `.context/` workflow state is extension-owned. The sole direct-write exception is the active stage's own canonical `.context/compound-engineering/stage-reports/<stage>.md` report; foreign stage reports and every other `.context/**` path remain blocked. `bash` calls are additionally classified by a deterministic shell-effect classifier, with unresolvable commands routed to the local Jev semantic layer (shadow by default). Set `features.stageGuard.disabled = true` to bypass both guards. Because writes are phase-separated, a fix whose units target different path classes must schedule each unit in its **owning** stage and carry any deferred unit through the cross-stage handoff — a unit assigned to a non-owning stage cannot execute.
- **SOTA ELIGIBILITY:** Automatic SOTA escalation (proactive Jev or stage-gate) is restricted to `01-brainstorm`, `02-plan`, and `04-5-debug`. `03-work`, `04-review`, `05-learn`, and `06-docsync` keep the default execution model unless an operator explicitly selects a per-stage model. They continue revising failed artifacts rather than escalating; legacy persisted escalation records are ignored.
- **STAGE COMPLETION GATE:** `context_handoff save` re-runs the stage's deterministic artifact predicates on every cross-stage completion save (blocking in both `shadow` and `enforce`), and in `enforce` also requires a fresh, enforcing `accept` record from the `stage_gate` tool. `features.stageGate.mode = "off" | "shadow" | "enforce"` (default `enforce`) is read once at init.
- **HANDOFF READINESS:** `context_handoff save` also runs a save-side semantic readiness guard (default `enforce`) that judges whether a fresh model can continue from the handoff. Five bounded Jev `noul` dimensions derive `continue | improve_handoff | preserve_current_session` in TypeScript; a deterministic pre-pass short-circuits empty cases without a Jev call. `enforce` blocks a non-`continue` verdict, and a blocked save writes no handoff artifact. Degraded/deterministic records are never reused as fresh. `features.handoffReadiness.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.handoffReadiness.failClosed = true` are read once at init; Jev never overrides a deterministic block.
- **DOCS VERIFICATION:** `context_handoff save` runs a deterministic docs-verification trigger at the `02-plan` and `03-work` completion pairs before the completion gate. Per-unit facts (declared files, manifest/lockfile versions, static imports, existing evidence) are computed in TypeScript; three bounded Jev `noul` questions derive `not_required | required | uncertain`. A `required` or `uncertain` unit creates an obligation that stays `open` until a `docs-verified: PACKAGE@VERSION DOC_REF` line makes it `satisfied`, or an operator `waive`s it with a reason (a waived obligation re-opens if the unit content hash changes). The `docs_verification` tool exposes `evaluate`, `status`, `record`, and `waive`. `features.docsVerification.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.docsVerification.failClosed = true` (default `false`, fail-open) are read once at init; a Jev outage degrades units to `uncertain` with obligations open and never marks evidence complete.
- **STAGE DRIFT GUARD:** At each `turn_end`, a turn-side guard (`extensions/ce-core/drift/`) builds a compact, redacted turn state from the event itself, runs a deterministic pre-pass, and asks Jev four bounded `noul` dimensions (`in_stage_scope`, `forbidden_work`, `scope_drift`, `progress`); TypeScript derives `no_drift | mild_drift | strong_drift` from the frozen tiered table (`forbidden_work` mild at `0.60`, strong only at `0.80` with confidence `0.60`; `progress` is supporting-only). In `enforce`, a mild turn injects one one-shot `## 🧭 Stage Drift Correction` on the next `before_agent_start`, and a fresh `strong_drift` record for the current stage + session blocks a cross-stage `context_handoff save` (after the stage gate, before the readiness guard; a blocked save writes no handoff artifact). Unknown/absent stage, trivial turns, unchanged turn signatures, and Jev outages fail open; degraded or deterministic turns never write or clear a record. `features.driftGuard.mode = "off" | "shadow" | "enforce"` (default `enforce`) is read once at init; `features.driftGuard.failClosed = true` blocks in `enforce` only for a fresh degraded `<stage>.status.json` marker (a never-judged, session-mismatched, version-mismatched, TTL-expired, or non-degraded state does not block). Delete `.context/compound-engineering/drift/<stage>.json` / `<stage>.status.json` to clear a block.
- **SEMANTIC COMPACTION GUARD:** At `session_before_compact`, a deterministic pressure pre-pass (`extensions/ce-core/compaction-guard/`) computes `triggerTokens`/`overageTokens`/`pressure` and one bounded Jev `noul` judgment decides whether an auto-compaction would split live work. In `enforce`, a `threshold` compaction is deferred (`{ cancel: true }`) only when the boundary is not clean and the overage is within budget; `manual`, `overflow`, and retry compactions always proceed. `turn_end` captures a pressure-only health snapshot for `context_handoff` (`good | watch | heavy | critical`) and fires a one-shot `request`-tier nudge. Unknown reason/window, a low-confidence answer, or a Jev outage fail open; degraded/deterministic outcomes never defer. The devDependency pins `@earendil-works/pi-coding-agent` `^0.80.6`, whose `session_before_compact` event carries both fields; on a harness that lacks them the guard derives `unknown` and stays inert (fail-open). `features.compactionGuard.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.compactionGuard.live = true` (opt-in live Jev call in `shadow`) are read once at init.
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
  ce-core/utils/ # Pure helpers: auto-advance, active-stage store, capability matrix, bash command-effect guard, solution ranking, model-role routing
  ce-core/tools/ # Pi tools + pure helper modules (output filters, failure triage)
  ce-core/review/ # Reviewer selection policy and fail-closed Gemini/agy lifecycle guard
  ce-core/stage-gate/ # Stage artifact rubrics, evidence, record store, save-side completion guard
  ce-core/handoff-readiness/ # Save-side semantic readiness guard, per-pair record store, shadow log
  ce-core/docs-verification/ # Runtime per-unit docs-verification guard (units, facts, combine, store, guard)
  ce-core/overengineering/ # Per-stage baseline + deterministic facts for the four floor-only Ponytail/YAGNI dimensions
  ce-core/injection-screen/ # Two-phase tool_result provenance screen
  ce-core/drift/ # Turn-level stage drift detection: turn-side pre-pass → bounded Jev dimensions → one-shot correction / strong block
  ce-core/compaction-guard/ # Semantic auto-compaction defer: deterministic pressure pre-pass → bounded Jev boundary judgment → enforce-only cancel
  ce-core/jev/   # Typed transport + runtime for CommandCode headless decisions (consumed by solution ranking, model-role routing, the stage gate, handoff readiness, docs verification, the bash stage guard, failure triage, and drift detection; no direct Pi tool surface)
plugins/         # Bundled external CLI plugins; agy reviewer plugin is installed explicitly
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
| `docs_verification` | Evaluate, inspect, record, or waive per-unit source-driven documentation obligations (`evaluate` / `status` / `record` / `waive`) |
| `multi_reviewer` | Run independent Pi reviewers or exact-ID Gemini reviewers through the explicitly installed, fail-closed agy guard; optional `mode: single \| deep` (deep is opt-in). Any requested reviewer failure aborts without a success sidecar. |
| `checklist_add` / `checklist_show` / `checklist_del` | Persistent task tracking with handoff gating (bulk add via `descriptions[]`) |
| `solution_search` | Rank `docs/solutions/**` cards for a query via Jev semantic ranking with a deterministic fallback (`mode: recall` / `overlap`) |
| `semantic_read` | Answer one bounded semantic question about a single repo file; returns a typed answer plus byte facts, never a file body |
| `semantic_scout` | Expand files/dirs/globs into a deduped candidate set, answer each within one deadline, and optionally recommend the first file to open |

**Handoff gating:** `context_handoff save` blocks cross-stage saves when the checklist is non-empty. The model must complete or delete all pending tasks before advancing to the next stage. Use `checklist_add` (accepts `descriptions: string[]`) when discovering tasks from SKILL.md, rules, or references to avoid dropped tasks.

**Stage guard:** `extensions/ce-core/utils/capability-matrix.ts` is a pure module that classifies a repo-relative path into one of 12 `PathClass` values and decides whether the active stage may write it. `extensions/ce-core/utils/active-stage.ts` tracks the live stage in memory and persists it to `.context/compound-engineering/active-stage.json` (gated on an existing `context-state.json`). The `pi.on("tool_call")` handler in `extensions/ce-core/index.ts` blocks forbidden `write`/`edit` calls before execution and fails open on any error.

**Bash stage guard:** `extensions/ce-core/utils/command-effect.ts` is a pure quote-aware shell-effect classifier that extracts literal targets and reuses `evaluateWrite`. `semantic-stage-guard.ts` owns policy/verdict mapping and builds the bounded Jev questions; `stage-guard-runtime.ts` orchestrates dedupe/serialization with all I/O injected; `guard-log.ts` appends redacted shadow verdicts to `.context/compound-engineering/jev-stage-guard.jsonl`. Modes are read once from `features.stageGuard.mode` (`off | shadow | enforce`, invalid values are rejected by config validation); `features.stageGuard.failClosed = true` opts into blocking on a degraded semantic layer. The deterministic verdict short-circuits before any Jev call.

**Failure triage:** a fourth `pi.on("tool_result")` handler (`failure-triage` + `failure-triage-runner` + `triage-store`) annotates a failed `test`/`typecheck`/`lint`/`build` bash result during `03-work` or `04-5-debug` with a bounded advisory TRIAGE block and persists a record under `.context/compound-engineering/triage/`. It is additive only: never returns `isError`, never mutates code, never changes exit status, and never bypasses stop-the-line. Jev outages degrade to a keyword heuristic, and any internal error fails open (the result is left unchanged).

**Stage completion gate:** `extensions/ce-core/stage-gate/` scores a stage's produced artifact (via the `stage_gate` tool) and persists content-hashed records under `.context/compound-engineering/stage-gates/`. `context_handoff save` re-runs the deterministic floor on every cross-stage completion save and consults the record for the semantic verdict. Deterministic failures block in both `shadow` and `enforce`; `features.stageGate.mode` (default `enforce`) is resolved once at init in `extensions/ce-core/stage-gate/store.ts`. The result also carries the conditional-review `action`/`actionReason` (see **Conditional independent review**), persisted as the optional `review` field on the attempt; stage-entry routing treats a persisted `escalate` action exactly like an `escalate` verdict. The two findings predicates (`multi_reviewer_findings`, `review_findings_persisted`) demand a sidecar only when the prior fresh action is `review`, and `resolvePriorGate` in `store.ts` reuses the single `isRecordFresh` predicate before consuming it.

**Handoff readiness:** `extensions/ce-core/handoff-readiness/` is a save-side semantic guard parallel to the stage gate. `combine.ts` owns the frozen types, the deterministic pre-pass, the byte-bounded Jev request, and the verdict derivation; `store.ts` persists one content-hashed record per stage pair plus a shadow log; `guard.ts` runs the authoritative order (deterministic floor → pre-pass → freshness reuse → Jev) with all I/O injected. `context_handoff save` consults it on cross-stage completion saves and `context_handoff validate` surfaces a record advisorily without ever calling Jev. `features.handoffReadiness.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.handoffReadiness.failClosed = true` are resolved once at init; degraded and deterministic records are never reused as fresh.

**Overengineering signal:** `extensions/ce-core/overengineering/` supplies what the stage gate lacks — a per-stage baseline and deterministic complexity facts — to four floor-only semantic dimensions (`no_unrequested_abstraction`, `scope_fidelity`, `complexity_proportionality`, `dependency_justification`). They are excluded from `weightedAverage` and can only lower a verdict through `OVERENGINEERING_FLOOR = 0.5`. `compose.ts` resolves the baseline first and short-circuits `off`/no-baseline without a git call; `facts.ts` degrades a git failure to empty facts plus skip reasons; `shadow-log.ts` appends calibration records. `features.overengineering.mode = "off" | "shadow" | "enforce"` (default `enforce`) is resolved once at init and is independent of `features.stageGate.mode`. Floor-only partition, exact-evidence, and the deferred H1/M1/M2 evidence findings are recorded in the [floor-only semantic dimensions card](docs/solutions/architecture/floor-only-semantic-dimensions-with-exact-evidence.md).

**Turn-level stage drift:** `extensions/ce-core/drift/` closes the gap the capability matrix and bash stage guard leave: a turn can stop honoring the active stage's mandate *without making a forbidden call*. `turn-state.ts` derives a compact, redacted state from the `TurnEndEvent` alone; `combine.ts` owns the frozen tiered table (`forbidden_work` mild `0.60` / strong `0.80`+conf `0.60`, `progress` supporting-only), the deterministic pre-pass, the byte-bounded Jev request, and the verdict derivation; `store.ts` resolves the mode/session key and persists per-stage records plus the shadow log plus an enforce-only per-stage `DriftStatus` health marker (`isDriftStatusFresh`, same 6 h TTL); `guard.ts` runs the authoritative order (mode → cap/dedupe → pre-pass → Jev) with all I/O injected. A mild enforce turn stores at most one correction, which the single existing `before_agent_start` handler appends once and then clears. `features.driftGuard.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.driftGuard.failClosed = true` are resolved once at init; `failClosed = true` blocks only a fresh degraded status, shadow writes no record or status, and degraded/deterministic records are never reused as fresh.

**Semantic compaction guard:** `extensions/ce-core/compaction-guard/` adds a semantic gate to Pi's automatic context compaction. `facts.ts` owns the only pressure math (`triggerTokens`, `headroomTokens`, `overageTokens`, `pressure`) and the pure tier→health bridge; `combine.ts` owns the four frozen `noul` questions (`task_switch`, `meaningful_boundary`, `history_need`, `mid_operation`), the byte-bounded request, and the good-boundary derivation; `store.ts` owns the in-memory episode state, the live snapshot mirror for the handoff provider, and the shadow log; `guard.ts` runs the authoritative order (short-circuits → reuse → cap → one Jev call → re-applied hard guards) with all I/O injected. The `session_before_compact` handler returns `{ cancel: true }` only in `enforce`; `turn_end` owns the snapshot and the one-shot `request` nudge (the hook itself does not own configuration parsing). `features.compactionGuard.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.compactionGuard.live = true` are resolved once at init; `shadow` makes no live Jev call unless `features.compactionGuard.live = true`, and every outage fails open to stock Pi.

**Docs verification:** `extensions/ce-core/docs-verification/` is a per-unit, phase-separated docs-verification guard. `units.ts` extracts plan units and the `docs-verified:` grammar; `facts.ts` computes deterministic package/version/evidence facts from manifests, lockfiles, and imports; `combine.ts` owns the decision table, package aggregation, and the byte-bounded Jev request; `store.ts` persists one content-hashed record per plan under `.context/compound-engineering/docs-verification/` and owns the single freshness predicate; `guard.ts` runs the authoritative order (short-circuit → facts → freshness reuse → one Jev `decide()`) with all I/O injected. A non-critical `source_verification_obligations` check on the `02-plan` and `03-work` rubrics consumes `Evidence.obligations`; the `docs_verification` tool and the save-side hook are wired in `extensions/ce-core/utils/docs-verification-wiring.ts`. `features.docsVerification.mode = "off" | "shadow" | "enforce"` (default `enforce`) and `features.docsVerification.failClosed = true` (default `false`) are resolved once at init; a Jev outage yields `uncertain` with open obligations and never marks evidence complete.

**Solution ranking:** `extensions/ce-core/utils/solution-ranking.ts` exposes `rankSolutions()`, the single entry point used by the `solution_search` tool, by stage auto-injection (`02-plan`, `04-review`, `04-5-debug`, `05-learn`) and by `05-learn` overlap detection. It ships shadow-first: `solutionRanking.shadow` defaults to `true`, so auto-injection computes and logs but stays inert until enforcement is enabled. A Jev outage returns the deterministic `prior` ranking (`status: "degraded"`), never an empty list. Auto-injection is composed inside the single existing `before_agent_start` handler (`extensions/ce-core/utils/solution-wiring.ts`).

**Model routing (roles):** `extensions/ce-core/utils/model-routing.ts` owns the deterministic role resolver `resolveExecutionRole()` and the one-shot orchestrator `resolveStageRouting()`, consulted by `switchStageConfig` in `commands/pedstack.ts` at stage entry. Three roles live in the optional top-level `models` block (`default` workhorse, `review` independent reviewer, `sota` escalation); thresholds live in the optional `routing` block (`shadow`, `sotaMinScore`, `sotaMinConfidence`, `maxEscalationsPerStage`; defaults `true`, `0.6`, `0.5`, `1`). Precedence is fixed: explicit per-stage `model` override → stage-gate `escalate` → Jev judgment → `default`. Jev answers five atomic `noul` questions combined with fixed weights in TypeScript; the resolver never selects `review` as an execution role. `multi_reviewer` falls back to `models.review` only when a stage has no explicit `reviewers[]`, and review isolation comes from the separate no-session reviewer invocation; `models.review` may intentionally reuse the same model id as `models.sota` or another execution role. Decisions persist to `.context/compound-engineering/routing/<stage>.json` (`routing-store.ts`), which also carries `revisions`/`reviews` counters derived from the retained stage-gate attempts (`ATTEMPT_CAP = 3`); `escalations` counts only **proactive Jev-triggered** `sota` selections. `maxEscalationsPerStage` caps those proactive selections only: a deterministic gate `escalate` is honored even when the budget is exhausted, so correctness always outranks cost. When a gate returns `escalate`, the model stops the stage loop; with enforced routing (`routing.shadow = false`), the extension automatically re-enters the same stage under `models.sota` after the turn finishes and the session is idle. Shadow mode records the decision but does not apply it. The model never invokes `/ped-reload` itself or switches models mid-turn; `/ped-reload` is the operator fallback if automatic reload cannot start. A new workflow root (`/ped-start`, `/ped-fix-issues`) clears the previous workflow's routing records and stage-gate records so the proactive budget resets and a stale gate `escalate` cannot influence the new workflow; `/ped-next`, `/ped-reload`, and `/ped-debug` preserve that state. Per-stage `model`/`thinkingLevel` entries remain supported as **explicit operator overrides** that win verbatim over gate escalation and Jev routing; they are not the normal configuration style. Ships shadow-first: `routing.shadow` defaults `true`, and operators with neither block configured spawn no Jev subprocess and keep byte-identical behavior.

**Conditional independent review:** `extensions/ce-core/review/policy.ts` is a pure policy module that maps the gate verdict plus the retained review budget and reviewer availability to one bounded `ReviewAction` (`none | revise | review | escalate`). `accept → none`, `revise → revise`, `escalate → escalate`; `review → review` (one reviewer) unless `MAX_INDEPENDENT_REVIEW = 1` is already spent for the current stage loop or no independent reviewer resolves, in which case it maps to `escalate` with an explicit reason. A successful `accept` ends the loop, so a later re-entry starts a fresh budget; `independentReviewCount` counts the retained prior attempts whose verdict is `review` since the newest `accept`. The `stage_gate` tool resolves reviewer availability once (`getConfigKeyForSkill` + `hasIndependentReviewer`, which treats any configured reviewer as available because the reviewer runs in a separate no-session process), `evaluate.ts` computes and persists the decision, and `model-routing.ts` reads the persisted action. `multi_reviewer mode: "single"` runs one reviewer and `mode: "deep"` runs the full configured set; omitting `mode` keeps legacy behavior and `deep` is only used on an explicit user request. A zero-finding reviewer run persists a well-formed `count: 0` sidecar, so the two critical findings predicates can be satisfied without a deadlock.

**Semantic file reads:** `semantic_read` (one file) and `semantic_scout` (files/dirs/globs) are thin wrappers over one engine, `extensions/ce-core/utils/semantic-file-ask.ts`, registered by `extensions/ce-core/utils/semantic-wiring.ts`. They return typed per-path answers plus deterministic byte facts — never file bodies — so the agent opens only the files it needs. Path safety, pruning, binary/empty detection, dedupe, caps, ordering, status, and savings stay in TypeScript; Jev answers one bounded question per call. Budgets come from the `semanticRead` config block (`resolveSemanticReadConfig` in `config-types.ts`; defaults `excerptBytes` 4096, `maxPaths` 24/hard cap 32, `concurrency` 4, `selectLimit` 12, `deadlineMs` 45000, `select` true). Traversal policy (prune + containment) must apply at every expansion entry point, not only discovered children; a Jev outage degrades to explicit `read`/`grep` guidance.

**Injection screen:** `extensions/ce-core/injection-screen/` runs a two-phase `tool_result` screen around the bash/read size filters. Phase 1 (registered first) classifies provenance deterministically (`http`, `gh-issue`, `gh-pr`, `gh-api`, `external-path`) and, for untrusted sources only, asks Jev one bounded `noul` question; phase 2 (registered last) prepends a fixed warning wrapper around the final content only in `enforce`+`flagged` mode. It never blocks and never rewrites (the wrapper surrounds verbatim content). `features.injectionScreen.mode = "off" | "shadow" | "enforce"` (default `enforce`) is resolved once at init; omitted values use `enforce`, and invalid values are rejected by config validation. Jev outages are `degraded`, an unwrapped verdict is a `wrap-miss`; both pass content through unchanged. Sanitized metadata-only records go to `.context/compound-engineering/injection-screens.jsonl` (at most 128 verdicts per turn).

## Code Style

- TypeScript strict mode
- After changing a shared interface (especially making a field required), run `bun x tsc --noEmit` until clean — `bun test` transpiles without type-checking, so a missing field stays invisible to the suite
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
- `bun x tsc --noEmit` fails on a diff that touches a shared type or an `Evidence`-like contract (a green `bun test` is not a type-safety verdict)
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
