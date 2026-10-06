# pi-pedstack

**Turn your AI coding agent into a reliable engineer.**

pi-pedstack is a Pi-native engineering workflow layer: it adds stage discipline, durable artifacts, TDD gates, checkpoints, review, and learning loops on top of your coding agent.

Install, describe what you want to build, then keep saying "continue." pi-pedstack drives the full loop:

 **think → plan → build → review → compound learnings.**

```bash
pi install git:github.com/pedrozadotdev/pi-pedstack
```

---

## Highlights

- **REST-like pipeline loop** — brainstorm → plan → work → review → learn → docsync, with automatic skill routing. Enter debug on demand via `/ped-debug`.
- **Checkpoint resume** — interrupted? Resume from the exact unit you left off
- **TDD enforcement** — every unit follows RED → GREEN → REFACTOR with hard gates
- **Evidence-first review** — auto-assigned reviewers across five axes, autofix loop
- **Knowledge compounding** — solved problems become searchable solution artifacts
- **Semantic solution search** — the `solution_search` tool and stage auto-injection rank `docs/solutions/` cards with a Jev semantic layer over a deterministic, never-weaker fallback; ships shadow-first (inert until `solutionRanking.shadow=false`)
- **Cheap semantic file reads** — `semantic_read` (one file) and `semantic_scout` (files/dirs/globs) return typed per-path answers plus byte facts — **never file bodies** — so the agent opens only the files it truly needs; a Jev outage degrades to explicit `read`/`grep` guidance
- **Model roles & task-shaped routing** — declare three roles once (`models.default` cheap workhorse, `models.review` independent reviewer, `models.sota` escalation) and let stage entry resolve the execution role with a fixed precedence (explicit override → stage-gate `escalate` → Jev judgment → cheap fallback); ships shadow-first (`routing.shadow` defaults `true`)
- **Persistent task tracking** — checklist tools (`checklist_add`/`checklist_show`/`checklist_del`) prevent dropped tasks and unsafe stage handoffs
- **Deterministic stage guard** — the `write`/`edit` tools are blocked when they target a path outside the active stage's capability matrix (e.g. source edits during `02-plan`), with fail-open on unknown paths and a `PEDSTACK_DISABLE_GUARD=1` escape hatch
- **Bash stage guard (shadow by default)** — an indirect-surface guard classifies `bash` commands by effect (writes, deletes, installs, package runners, pipes) and logs verdicts to `.context/compound-engineering/jev-stage-guard.jsonl`; set `PEDSTACK_JEV_STAGE_GUARD=enforce` to block
- **Stage completion gate** — every stage scores the artifact it produced before its cross-stage handoff. Deterministic per-stage predicates (artifact present, required headings, no placeholders, persisted review findings) block in **both** `shadow` and `enforce`; CommandCode `typesafe/jev` adds a bounded semantic score via the `stage_gate` tool. `PEDSTACK_STAGE_GATE=off|shadow|enforce` (default `shadow`)
- **Semantic overengineering signal (shadow-first)** — four floor-only dimensions (`no_unrequested_abstraction`, `scope_fidelity`, `complexity_proportionality`, `dependency_justification`) ride the existing stage-gate Jev request and judge whether an artifact added only *justified* complexity. They are excluded from `weightedAverage` and can only lower a verdict via `OVERENGINEERING_FLOOR = 0.5`. Ships inert (`PEDSTACK_OVERENGINEERING=off|shadow|enforce`, default `shadow`), independent of `PEDSTACK_STAGE_GATE`
- **Untrusted injection screen** — a two-phase `tool_result` screen classifies provenance (HTTP, `gh` reads, external paths) and asks Jev one bounded question; `enforce` prepends a deterministic warning wrapper around flagged content without rewriting it. Ships shadow-first (`PEDSTACK_INJECTION_SCREEN=off|shadow|enforce`, default `shadow`), fails open on Jev failure and wrap-miss
- **Failure triage** — a failed `test`/`typecheck`/`lint`/`build` command during `03-work` or `04-5-debug` gains an inline, bounded advisory TRIAGE block (category, relation to recent change, root-cause clarity) and a record under `.context/compound-engineering/triage/`; Jev degrades to a deterministic heuristic on outage, and triage never auto-fixes or changes the exit status
- **🐴 Ponytail Discipline** — YAGNI-first code philosophy dynamically injected into plan, work, review, and debug stages: resist unrequested abstractions, prefer stdlib, write the minimum code that works
- **Token-efficient** — ~3,700 tokens new-conversation overhead; progressive loading

---

## Quickstart

```bash
pi install git:github.com/pedrozadotdev/pi-pedstack
```

Then in Pi:

```
You: I want to build a CLI tool that helps indie devs find early users

→ 01-brainstorm: structured discovery → requirements artifact
→ 02-plan: TDD-gated implementation units → plan artifact
→ 03-work: inline execution, checkpoint resume
→ 04-review: five-axis findings, autofix loop
→ 05-learn: knowledge compounding
→ 06-docsync: synchronize documentation

**On-demand:** `/ped-debug` enters the debug stage when bugs are found during review

You: continue
→ Auto-resolves next stage via /ped-next
```

**Resume after interruption:**

```
You: /ped-next
→ Auto-resolves the next stage, applies model/thinking config, resumes from latest checkpoint
```

**Restart current stage clean:**

```
You: /ped-reload
→ Refreshes the current stage with a clean context, re-applies the stage's skill config
```

Skill invocation, reload, and model/thinking level switching are handled automatically by `/ped-start`, `/ped-next`, and `/ped-reload`.

---

## The REST-like Pipeline Loop

```
01-brainstorm → 02-plan → 03-work → 04-review → 05-learn → 06-docsync
    think         plan      build      review       learn      docsync
```

> **On-demand:** Enter `04-5-debug` (debug stage) via `/ped-debug` when bugs are found during review.

| Skill | What it does | Core tool |
|-------|-------------|-----------|
| **01-brainstorm** | Structured multi-round discovery, domain vocabulary persistence | `brainstorm_dialog`, `artifact_helper` |
| **02-plan** | TDD-gated implementation units, mandatory Strict Review before `multi_reviewer` | `plan_diff`, `context_handoff`, `artifact_helper`, `multi_reviewer`, `solution_search` |
| **03-work** | Execution with checkpoint resume, strict TDD | `session_checkpoint`, `task_splitter`, `context_handoff` |
| **04-review** | Auto-assigned reviewers, five-axis findings, autofix loop | `review_router`, `multi_reviewer`, `context_handoff`, `solution_search` |
| **04-5-debug** *(on-demand)* | Debug and fix issues with a 5-phase workflow: Information Gathering, Root Cause Analysis, Implementation, Verification, Report. Enter via `/ped-debug`. | `context_handoff`, `solution_search` |
| **05-learn** | Pattern extraction → searchable solution artifacts | `pattern_extractor`, `context_handoff`, `artifact_helper`, `solution_search` |
| **06-docsync** | Synchronize project documentation after completion | `context_handoff`, `stage_gate` |

Before a stage saves its completion handoff it runs the `stage_gate` tool on the artifact it produced; see [Stage completion gate](#stage-completion-gate-jev-scoring).

### Model & Thinking Routing

You can customize the model and thinking level used for each workflow stage by editing the configuration file.

The configuration is loaded with the following priority:

1. **Project-level**: `.pi/pi-pedstack/config.json`
2. **Global-level**: `~/.pi/pi-pedstack/config.json`

Model and thinking level switching is handled automatically by the ce-core extension when you invoke a pipeline stage via `/ped-start <prompt>` or `/ped-next [prompt]`. Each command reads the per-stage config and switches the active model and thinking level before invoking the skill.

All pipeline skills declare `disable-model-invocation: true` in their frontmatter to ensure they can only be invoked by the user via explicit commands, strictly guaranteeing that model routing rules are enforced.

#### Model roles & task-shaped routing (Jev)

Instead of maintaining a model per stage, you can declare **three roles once** and let Pedstack route each stage entry to the right one. Roles are opt-in: nothing changes until a `models` or `routing` block exists.

```json
{
  "models": {
    "default": { "model": "anthropic/claude-haiku-3-5-20241022", "thinkingLevel": "medium" },
    "review":  { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" },
    "sota":    { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
  },
  "routing": {
    "shadow": true,
    "sotaMinScore": 0.6,
    "sotaMinConfidence": 0.5,
    "maxEscalationsPerStage": 1
  }
}
```

- **`models.default`** — the cheap normal-execution workhorse.
- **`models.review`** — the independent reviewer, used only when a stage has no explicit `reviewers[]` and never when it equals `models.default`/`models.sota`.
- **`models.sota`** — the escalation model, reached only through deterministic evidence or a qualifying Jev judgment.
- **`routing.shadow`** — when `true` (default) routing computes and persists a decision but keeps applying the legacy per-stage model.
- **`routing.sotaMinScore` / `sotaMinConfidence`** — deterministic thresholds (`[0, 1]`) a Jev judgment must clear before it may select `sota`.
- **`routing.maxEscalationsPerStage`** — spend cap (`>= 1`) on applied `sota` escalations per stage.

**Precedence at stage entry** (deterministic before semantic):

1. An explicit per-stage `"model"` override wins verbatim.
2. A stage-gate `escalate` verdict for the stage → `sota` (no Jev call).
3. Otherwise Jev answers five bounded `noul` questions (`complexity`, `risk`, `cross_cutting`, `deep_reasoning`, `ambiguity`); TypeScript combines them with fixed weights and thresholds. Cleared with budget available → `sota`; threshold cleared but budget spent → `budget_exhausted`.
4. Anything else — including a Jev outage or invalid answer → `default`.

Every decision is persisted to `.context/compound-engineering/routing/<stage>.json` with its `role`, `reason` (`override | gate_escalate | jev | budget_exhausted | fallback`), `source`, and (for Jev) the atomic scores.

**Migration strategy:** roles coexist with per-stage config. Run the default **shadow phase** first (`routing.shadow = true`; legacy models still apply, decisions are logged and persisted), then set `routing.shadow = false` to enforce, and eventually fold per-stage keys into `models` with a codemod (not shipped here). Operators with neither `models` nor `routing` configured keep byte-identical behavior and spawn no Jev subprocess.

**Known limitation:** the review-independence guard compares `models.review` only against `models.default`/`models.sota`, not against a per-stage `review.model` override, so a config that sets both to the same id can still review itself. Tracked in the [independence-guard solution card](docs/solutions/workflow/independence-guards-must-enumerate-every-execution-model-source.md).

Here is a complete configuration schema example:

```json
{
  "brainstorm": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "plan": {
    "model": "anthropic/claude-opus-4-20250115",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "work": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  },
  "review": {
    "model": "anthropic/claude-opus-4-20250115",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-sonnet-4-20250514", "thinkingLevel": "high" }
    ]
  },
  "debug": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  },
  "learn": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "docsync": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  },
  "solutionRanking": {
    "minRank": 0.6,
    "minConfidence": 0.5,
    "concurrency": 4,
    "candidates": 15,
    "limit": 3,
    "shadow": true
  },
  "semanticRead": {
    "excerptBytes": 4096,
    "maxPaths": 24,
    "concurrency": 4,
    "selectLimit": 12,
    "deadlineMs": 45000,
    "select": true
  },
  "models": {
    "default": { "model": "anthropic/claude-haiku-3-5-20241022", "thinkingLevel": "medium" },
    "review":  { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" },
    "sota":    { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
  },
  "routing": {
    "shadow": true,
    "sotaMinScore": 0.6,
    "sotaMinConfidence": 0.5,
    "maxEscalationsPerStage": 1
  }
}
```

#### Supported Keys and Options

- **`reviewers`**: Stages that support parallel reviews (`brainstorm`, `plan`, `review`, `learn`) can define an array of sub-reviewers. These reviews will run concurrently using subagents on the specified models.
- **`solutionRanking`**: Tunables for the semantic solution-ranking engine. All keys are optional and fall back to the defaults shown above.
  - `minRank` / `minConfidence` — a card must reach both (`rank >= minRank` and `confidence >= minConfidence`) to qualify; numbers in `[0, 1]`.
  - `concurrency` — maximum in-flight Jev decisions (integer `>= 1`).
  - `candidates` — deterministic recall cap before any Jev call (integer `>= 1`).
  - `limit` — maximum cards returned/injected (integer `>= 1`).
  - `shadow` — when `true` (default), auto-injection computes and logs but stays inert. Set to `false` to enforce stage injection. Unknown keys warn and are ignored; invalid values throw.
- **`semanticRead`**: Tunables for the semantic read/scout engine (`semantic_read`, `semantic_scout`). All keys are optional and fall back to the defaults shown above.
  - `excerptBytes` — per-path UTF-8 byte cap sent to Jev (integer `>= 1`).
  - `maxPaths` — default scout cap on scored paths; clamped to 32 at engine runtime (integer `>= 1`).
  - `concurrency` — maximum in-flight Jev decisions (integer `>= 1`).
  - `selectLimit` — maximum candidates in the second-pass Choice, capped at 20 (integer `>= 1`).
  - `deadlineMs` — total scout deadline in milliseconds (integer `>= 1`).
  - `select` — when `true` (default), `semantic_scout` runs the second-pass Choice recommendation. Unknown keys warn and are ignored; invalid values throw.
- **`models`**: Named model roles (`default`, `review`, `sota`). Each role takes `{ "model": string, "thinkingLevel"?: string }`; all three keys are optional. Unknown keys warn and are ignored; invalid values throw. See [Model roles & task-shaped routing](#model-roles--task-shaped-routing-jev).
- **`routing`**: Tunables for role resolution. All keys are optional and fall back to the defaults shown above.
  - `shadow` — when `true` (default), routing computes and persists a decision but keeps applying the legacy per-stage model. Set to `false` to enforce role-based switching.
  - `sotaMinScore` / `sotaMinConfidence` — a Jev judgment must reach both (`weighted >= sotaMinScore` and `confidence >= sotaMinConfidence`) before it may select `sota`; numbers in `[0, 1]`.
  - `maxEscalationsPerStage` — cap on applied `sota` escalations per stage (integer `>= 1`).

### Dynamic Append Instructions

For each stage, you can inject custom project-specific instructions by creating markdown files in the `.agents/appends/` directory at your project root.

The system loads two sources per stage, merged into the system prompt:

**Global (all stages):** `.agents/appends/ALL.md` — if present, injected into every stage.

**Per-stage:** Uppercase file names matching the active step name:

- `.agents/appends/BRAINSTORM.md`
- `.agents/appends/PLAN.md`
- `.agents/appends/WORK.md`
- `.agents/appends/REVIEW.md`
- `.agents/appends/DEBUG.md`
- `.agents/appends/LEARN.md`
- `.agents/appends/DOCSYNC.md`

If both `ALL.md` and a per-stage file exist, their contents are combined (global first, then stage-specific). If present, these files are loaded and appended directly to the active prompt context, helping customize guidelines for specific steps.

## Design Philosophy & Acknowledgements

**80% planning and review, 20% execution.**

The goal is not to make AI write code faster. The goal is to make AI think before writing, review after writing, and compound what it learns.

pi-pedstack is not a fork or wrapper. It extracts useful methods from the projects below and rebuilds them with Pi-native skills, tools, artifacts, checkpoints, and handoffs.

| Project | What pi-pedstack adopted |
|---------|------------------------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | "Use when" skill trigger conditions, source-driven verification, stop-the-line hard gate, anti-rationalization, and the five-axis review baseline. Adopted as embedded micro-patterns only — no new skills, tools, commands, or agents. |
| [everything-claude-code](https://github.com/affaan-m/everything-claude-code) | Checkpoint resume, continuous learning loops, and token-conscious agent workflow design. |
| [humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents) | Context window ownership, compacting resolved errors, retry caps, and pre-fetching obvious prerequisites. Adopted as lightweight context hygiene rules inside the existing Phase 1 pipeline. |
| [superpowers](https://github.com/obra/superpowers) | Strict TDD gates, design checklists, review discipline, and the idea that agents need hard gates instead of gentle suggestions. |
| [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | The five-step think → plan → build → review → learn loop and the knowledge-compounding backbone. |
| [gstack](https://github.com/garrytan/gstack) | YC-style forcing questions, CEO Review cognitive frameworks, browser QA patterns, failure maps, and evidence-first validation. |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Context glossary (`CONTEXT.md`) for cross-session term persistence, lightweight ADR with three-condition threshold, and feedback-loop-first debug discipline. Adopted as reference templates embedded into existing skills — no new skills or tools. |

---

## Behavioral Gates

### Stop-the-line (Hard gate)

When an unexpected failure occurs during `03-work`:

1. **STOP** adding features
2. **PRESERVE** evidence
3. **DIAGNOSE** root cause — build a feedback loop first, then reproduce → hypothesise → instrument → fix
4. **FIX** the root cause, not the symptom
5. **GUARD** with a regression test
6. **RESUME** only after verification passes

Anti-rationalization: do not rationalize, downgrade, or explain away failures. Stop and report with evidence.

### Source-driven verification

When implementation depends on a framework/library API, version-specific behavior, or a recommended pattern: verify against official documentation using the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](skills/references/contextqmd-docs.md)) before implementing. Pure logic, renaming, or in-project pattern reuse does not require external citation.

### Review five axes

All reviewers evaluate changes across: **correctness, readability, architecture, security, performance.**

### Stage completion gate (Jev scoring)

Cross-stage progression is not just "the checklist is empty": the ce-core extension scores the artifact each stage produced before allowing a completion handoff.

- **Deterministic floor (blocks in `shadow` and `enforce`)** — pure per-stage predicates: the canonical artifact is present and non-empty, required headings exist, minimum length, no placeholder tokens, review findings persisted with path:line evidence, checkpoints consistent, verification recorded. A failure means: fix the artifact and re-run `stage_gate`.
- **Semantic verdict (warns in `shadow`, blocks in `enforce`)** — the `stage_gate` tool sends the artifact and deterministic results to CommandCode `typesafe/jev`, then combines the bounded per-dimension scores with TypeScript into one of `accept | revise | review | escalate`.
- `context_handoff save` re-runs the deterministic floor on every cross-stage completion save, so a fresh `accept` record can never override a drifted artifact.
- `PEDSTACK_STAGE_GATE = off | shadow | enforce` (default `shadow`) is read once at extension init.

Records are persisted per stage under `.context/compound-engineering/stage-gates/<stage>.json` with a content hash; `enforce` only accepts a fresh, enforcing `accept`.

**Known limitations:** the semantic scorer needs CommandCode to be available — when the runtime is unavailable the score is marked `jev unavailable` and the deterministic floor still decides. The placeholder predicate currently rejects normal schema notation (`<string>`, `<sha256>`) and the shared `stage-reports/` fallback can resolve the wrong stage's report; both confirmed defects are recorded in the [stage-gate solution card](docs/solutions/workflow/stage-artifact-completion-gate-shadow-first-rubrics.md).

### Overengineering signal (shadow-first)

The Ponytail/YAGNI discipline is injected as prompt prose into `02-plan`, `03-work`, `04-review`, and `04-5-debug`. The overengineering signal (`extensions/ce-core/overengineering/`) gives the stage gate four semantic dimensions that check whether the artifact added only *justified* complexity — `no_unrequested_abstraction`, `scope_fidelity`, `complexity_proportionality`, and `dependency_justification`.

- **Floor-only, never averageable.** The four dimensions are excluded from `weightedAverage`, so they cannot move a historical verdict boundary. They can only lower a verdict: any present dimension below `OVERENGINEERING_FLOOR = 0.5` blocks `accept` when enforcement is on. A skipped dimension is absent from `sem` with a reason in `skippedDimensions[]` — never a sentinel score.
- **Independent shadow flag.** `PEDSTACK_OVERENGINEERING = off | shadow | enforce` (default `shadow`) is read once at init and is independent of `PEDSTACK_STAGE_GATE`, so calibrating one judgment cannot force the other. An invalid value resolves to `shadow`, never `off`.
- **Deterministic baseline first.** Each stage's normative excerpt (requirements for `02-plan`, the plan for `03-work`, both for `04-review`) is resolved from files — never a network fetch. A missing baseline short-circuits to `unavailable` with no git call; `off` performs no reads.
- **Exact evidence, injected I/O.** `facts.ts` extracts diff, manifest, and untracked-file facts behind an injected `runGit`; a git failure degrades to empty facts plus skip reasons. The record's `source` separates a real reading (`jev`) from an outage or a size trim, so the calibration log never counts an outage as a reading.

**Enforcement checkpoint:** flip `PEDSTACK_OVERENGINEERING` to `enforce` only after the D10 calibration data exists. The `04-review` pass confirmed the feature and found 1 high + 2 moderate + 4 low findings, all in the deterministic evidence path: H1 treats a directory with *no* `package.json` as unreadable (permanently skipping `dependency_justification`), M1 extracts script/nested manifest keys as dependencies, and M2 stamps a Jev outage as `source: "jev"`. None change a verdict while the signal is inert; they are deferred to an on-demand `04-5-debug` pass and recorded in the [floor-only semantic dimensions card](docs/solutions/architecture/floor-only-semantic-dimensions-with-exact-evidence.md).

### Handoff readiness (#10)

A handoff can pass every structural probe and still be semantically empty — a bare `/ped-next` next step, `verification: ran tests` with no command or result, stale active files, blocking open decisions, or missing history. The save-side readiness guard (`extensions/ce-core/handoff-readiness/`) is layered **on top of** the deterministic floor, which stays authoritative: Jev can only add a block, never override a deterministic one.

- **Five bounded `noul` judgments** — `continuation_sufficiency`, `next_step_clarity`, `verification_support`, `blocking_open_decisions`, and `history_need`. Jev answers the signals; TypeScript derives the verdict.
- **Verdict** — `continue | improve_handoff | preserve_current_session`, derived in `combine.ts`. Only `enforce` blocks; `shadow` records and warns. A non-`continue` verdict blocks with the per-dimension **corrections** named, and a blocked save writes **no handoff artifact** (the readiness record and shadow log are still written).
- **Deterministic pre-pass first.** Empty verification, a bare/placeholder next step, empty open decisions, and any missing active file force the relevant dimension without a Jev call; a forced non-`continue` short-circuits with `source: "deterministic"`.
- **Never-weaker fallback.** A Jev outage degrades (`source: "degraded"`) to an `improve_handoff` advisory; a degraded or deterministic record is **never** reused as fresh, so an outage cannot disable later recomputation.
- **Advisory read-back.** `context_handoff validate` returns the latest record for the resolved pair without ever calling Jev.
- `PEDSTACK_HANDOFF_READINESS = off | shadow | enforce` (default `shadow`) is read once at extension init.
- `PEDSTACK_HANDOFF_READINESS_FAILCLOSED=1` blocks in `enforce` when the semantic layer is **degraded**; the default is fail-open.

**Known limitations (deferred to an on-demand `04-5-debug` pass):** the deterministic pre-pass checks `activeFiles` only, not the union with `recentlyAccessedFiles`, so a deleted recent-only file can still be judged `continue`; and `validate`'s surfacing matches on pair + thresholds version alone, so it can return a stale or degraded record instead of the required “never a stale one”. The fix is to reuse the single exported freshness predicate at every read site — recorded in the [read-site freshness card](docs/solutions/architecture/one-freshness-predicate-reused-at-every-read-site.md).

### Turn-level stage drift detection (#8)

The capability matrix (#3) and the bash stage guard (#4) only act on a specific `write`/`edit`/`bash` call whose *effect* is forbidden. A cheap worker can still stop honoring a stage's mandate **without making a forbidden call** — `02-plan` starts implementing, `04-review` edits the code it reviews. The drift guard (`extensions/ce-core/drift/`) closes that gap at the turn boundary.

- **Turn-side detection.** At each `turn_end`, TypeScript builds a compact, redacted turn state from the event itself (no cross-event accumulator), runs a deterministic pre-pass, and asks CommandCode `typesafe/jev` one bounded `noul` request over four dimensions: `in_stage_scope`, `forbidden_work`, `scope_drift`, `progress`. TypeScript derives `no_drift | mild_drift | strong_drift`; Jev never decides the verdict.
- **One-shot correction (enforce).** A mild turn stores at most one correction; the single existing `before_agent_start` handler appends it once (`## 🧭 Stage Drift Correction`) and clears it. No forced continuation, so no loop. `shadow` never injects.
- **Strong block (enforce).** A fresh `strong_drift` record for the current stage **and** session blocks a cross-stage `context_handoff save` in its deterministic floor (after the stage gate, before the readiness guard). A blocked save writes no handoff artifact. `shadow` only warns.
- **Never weaker than today.** `off`, an unknown/absent stage, a trivial turn, an unchanged turn signature, or a Jev outage all fail open (deterministic `no_drift`). A degraded or deterministic turn never writes or clears a record, so it can never clobber a strong one.
- `PEDSTACK_DRIFT_GUARD = off | shadow | enforce` (default `shadow`) is read once at extension init. Missing/empty/invalid values fall back to `shadow` with a one-time warning and never silently resolve to `off`; changing it requires a restart.
- `PEDSTACK_DRIFT_GUARD_FAILCLOSED=1` blocks in `enforce` when there is **no fresh Jev record** (semantic drift layer degraded or never run); the default is fail-open.

Records are persisted per stage at `.context/compound-engineering/drift/<stage>.json`. The block message **names this path**: delete `.context/compound-engineering/drift/<stage>.json` to clear the block (a missing file means no block), or set `PEDSTACK_DRIFT_GUARD=off` (restart required). A session only honors records whose `sessionKey` matches the current session, so a fresh session starts clean.

**Shadow is not free.** The default `shadow` mode still calls Jev on the awaited `turn_end` handler — up to 24 distinct non-trivial turns per session, 8 s timeout each — so it adds latency even though it never blocks or injects. See the [shadow-mode-is-not-free card](docs/solutions/architecture/shadow-mode-is-not-free-on-awaited-hooks.md).

**Stay in `shadow` and calibrate first.** Shadow computes and logs every judgment (including `dimensions`, `triggered`, and `jevCalled`) to `.context/compound-engineering/drift.jsonl` (rotated at 1 MiB) while blocking nothing. **Promote to `enforce` only after** at least 100 judged turns over a representative multi-stage run, a mild-correction rate below 20% of non-trivial turns, zero false-positive strong verdicts on a manually labeled in-scope set, a degraded rate below 5%, and no drift-caused blocked save with a false positive.

### Deterministic stage guard

Stage discipline is not just prompt text. The ce-core extension hooks tool calls and checks them against the active stage's capability matrix before they execute.

**`write`/`edit` (path-based).** Each target path is classified before the write executes. A call that targets a foreign class is blocked with a deterministic reason — for example, a `02-plan` session cannot edit `extensions/` source, and no stage may write `.context/` workflow state directly (it is managed by extension tools).

- Paths classify into 11 classes (brainstorm, plan, review, solution, docs, tests, source, config, deps, workflow-state, unknown).
- The `workflow-state` invariant is evaluated first, so `.context/**` is always blocked regardless of basename.
- `unknown` paths always pass (fail-open) so third-party or unclassified files are never trapped.
- The guard fails open on any internal error and reports at most once per session.

**`bash` (indirect surface).** A deterministic shell-effect classifier splits a command (quote-aware), classifies each segment by effect (`read_only`, `mutates_workspace`, `deletes_or_destructive`, `installs_dependencies`, `runs_tests_or_builds`, `package_runner`, `pipe_to_shell`, `container_or_remote`, `ambiguous`), and reuses the same path classifier for literal targets. Commands the classifier cannot prove are routed to the local Jev semantic layer for a bounded effect/intent answer. The deterministic verdict always wins — a model answer can only add a block, never weaken one.

- Default mode is **shadow**: verdicts are recorded to `.context/compound-engineering/jev-stage-guard.jsonl` (rotated at 1 MiB) but nothing is blocked, so you can calibrate before enforcing.
- `PEDSTACK_JEV_STAGE_GUARD=enforce` blocks forbidden/ambiguous commands; `off` disables the bash guard; any other or absent value fails safe to `shadow`.
- When the semantic layer is unavailable, ambiguous commands **fail open** by default. Set `PEDSTACK_JEV_STAGE_GUARD_FAILCLOSED=1` (with `enforce`) to block instead; a one-time degraded notice is shown.
- Set `PEDSTACK_DISABLE_GUARD=1` to bypass both guards entirely.

**Threat model:** deterrence against a drifting or careless agent, not a sandbox. Accepted bypasses are `$VAR`/globs/symlinks, `eval`, `curl | sh`, heredocs, and any command the classifier cannot prove. The `config` class is an exact-basename allowlist (`package.json`, `tsconfig.json`, `bunfig.toml`, `.github/`), so other config files (`.eslintrc.json`, `biome.json`, `tsconfig.build.json`) classify as `unknown` and are writable in every stage. Reusable lessons are recorded in the [path-classification card](docs/solutions/workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md) and the [bash guard card](docs/solutions/workflow/deterministic-first-semantic-guard-for-indirect-bash-tool-actions.md). One confirmed but unfixed issue remains in the path guard: activation can persist the wrong stage on a cancelled navigation (H1).

### Semantic solution ranking (shadow-first)

`02-plan`, `04-review`, `04-5-debug`, and `05-learn` can surface prior solution cards automatically. The engine (`extensions/ce-core/utils/solution-ranking.ts`) does deterministic recall first (≤ `candidates` cards), then asks Jev for three atomic `noul` judgments per candidate (`relevance`, `applicability`, `reuse`) and combines them in TypeScript (`rank = relevance × applicability`, `reuse` as a tie-breaker). Policy — thresholds, ordering, and status — never leaves TypeScript.

- **Status contract:** `ok` (1–3 cards crossed the bar), `none` (nothing crossed — an explicit “no prior learning”), or `degraded` (Jev unavailable; the top cards by the deterministic `prior` score are returned).
- **Never-weaker fallback:** `degraded` ignores the thresholds and returns the pre-Jev deterministic ranking, so a Jev outage never removes context that exists today.
- **Shadow-first:** `solutionRanking.shadow` defaults to `true`. In shadow mode the engine computes and logs a structured record (query hash, `prior` vs `rank` order, thresholds, drops) but the auto-injection hook returns `undefined` and the turn is unchanged. The `solution_search` tool works in either mode, so the model can opt in while the feature is calibrated.
- **One handler:** auto-injection is composed inside the single existing `before_agent_start` handler; a second handler or a `{ systemPrompt: event.systemPrompt }` no-op would break extension chaining.
- **Untrusted content:** injected card bodies are reference data, not instructions.

**Enforcement checkpoint:** before setting `solutionRanking.shadow=false`, resolve the deferred findings (M1 request-cap byte-bounding of every serialized frontmatter field, M2 silent catch, M3 module-singleton reset) recorded in the [shadow-first solution card](docs/solutions/architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md) via a `04-5-debug` pass. None block merge while the feature is inert.

### Semantic file reads & scouting (#14)

`semantic_read` answers one bounded semantic question about a single repo file; `semantic_scout` answers the same question across files, directories, and `*`/`**` globs. Both are thin wrappers over one engine (`extensions/ce-core/utils/semantic-file-ask.ts`) and return **typed answers plus deterministic facts — never file bodies** — so the agent opens only the files it actually needs.

| Tool | Input | Returns |
|------|-------|---------|
| `semantic_read` | `path`, `question`, optional `type`/`criteria`, `repoRoot` | one typed answer + `path`, `fileBytes`, `excerptBytes`, `truncated` |
| `semantic_scout` | `targets` (files/dirs/globs), `question`, optional `type`/`criteria`/`select`/`limit`, `repoRoot` | typed per-path answers + `counts` (with `omitted`), `savings`, optional `recommendation` |

- **Guidance:** use `semantic_read`/`semantic_scout` for *judgments* ("does this matter?", "which should I open?"); use `read` for exact text or editing and `grep`/the code graph for deterministic facts.
- **Budgets:** `excerptBytes` 4096, `maxPaths` 24 (hard cap 32), `concurrency` 4, `selectLimit` 12, `deadlineMs` 45000, `select` true — all tunable via the `semanticRead` config block.
- **Deterministic policy stays in TypeScript:** path safety, directory/file pruning (`.git`, `node_modules`, build dirs, lock/minified/generated files), binary/empty detection, dedupe, caps, ordering, status, and savings. Jev answers only one bounded question per call.
- **Status contract (`semantic_scout`):** `ok` (every attempted path answered), `partial` (some answers and some per-path failures, or zero answers without an outage), `empty` (no eligible candidates after pruning/filtering), `degraded` (Jev outage), `error` (invalid target/question/criteria). A per-path failure is isolated; it never aborts the batch.
- **Never-weaker degraded fallback:** a full Jev outage returns `status: "degraded"` with explicit `read`/`grep` guidance — the engine never throws and never returns an unexplained empty list.

**Known limitations (deferred to an on-demand `04-5-debug` pass):** the #14 review found that pruning and containment are enforced inside the child loop but not at every expansion entry point — an explicitly named pruned directory (`node_modules`) and a directory-symlink glob base are still walked, a zero-answer batch is reported as `partial` without explanation, and a file named `__proto__` is dropped from the second-pass Choice (M1, M2, M4, L6). Content is still protected by the downstream realpath check before any read, so this is a policy/semantics deviation, not a body leak. Findings are recorded in the [traversal-policy solution card](docs/solutions/architecture/apply-traversal-policy-to-expansion-roots.md).

### Untrusted tool-result injection screen (shadow-first)

The agent reads content it does not control — remote HTTP fetches, `gh` issue/PR reads, and files outside the repo. Before the size filters compress those results, the ce-core extension runs a two-phase provenance screen (`extensions/ce-core/injection-screen/`):

- **Phase 1 (raw, first `tool_result` handler)** classifies provenance deterministically (`http`, `gh-issue`, `gh-pr`, `gh-api`, `external-path`) and, for untrusted sources only, asks Jev exactly one bounded `noul` question. Local/in-repo results and `off` mode make zero Jev calls and write no log line.
- **Phase 2 (final, last `tool_result` handler)** consumes the stored verdict by `toolCallId` and, in `enforce` mode only, prepends a deterministic warning wrapper around the flagged content.
- **Never blocks, never rewrites.** The wrapper is prepended around the verbatim payload; in `shadow` the content is untouched.
- **Fail-open.** A Jev outage or malformed answer is `degraded`; a verdict phase 2 never sees is a `wrap-miss`. Both pass content through unchanged (with a one-time operator notice in `enforce` when a UI is present).
- **Bounded and metadata-only.** At most 128 verdicts are retained for the current turn; sanitized one-line records (no content, source ref stripped of credentials/query/fragment) are appended to `.context/compound-engineering/injection-screens.jsonl`.

- `PEDSTACK_INJECTION_SCREEN = off | shadow | enforce` (default `shadow`). Missing/empty/invalid values fall back to `shadow` with a one-time warning; the screen never silently resolves to `off`.
- **Shadow-first:** `shadow` computes and logs verdicts but leaves every result unchanged; `enforce` is opt-in and wraps only `flagged` results.

**Enforcement checkpoint:** flip the default to `enforce` only after shadow calibration shows a non-trivial flagged rate that has been reviewed. The thresholds (`noul ≥ 0.60` and `confidence ≥ 0.50`) stay provisional until that data exists.

**Known limitations (v1):** middle-only payloads beyond the 16 KiB sample window, content the bash tool truncated out of `event.content` (`fullOutputPath`), and in-repo copies of untrusted content are not screened.

---

## 🐴 Ponytail Discipline (YAGNI / Lazy Senior Dev Mode)

The Ponytail strategy keeps the codebase lean by forcing every implementation choice through a 6-rung ladder before any code is written. It is dynamically injected into the system prompt during `02-plan`, `03-work`, `04-review`, and `04-5-debug` stages.

### The 6 Rungs (in order)

| # | Question | Action |
|---|----------|--------|
| 1 | Does this need to be built at all? | YAGNI — delete the requirement if possible |
| 2 | Does the standard library already do this? | Use it |
| 3 | Does a native platform feature cover it? | Use it |
| 4 | Does an already-installed dependency solve it? | Use it |
| 5 | Can this be one line? | Make it one line |
| 6 | Only now | Write the minimum code that works |

### Rules

- **No unrequested abstractions** — interfaces, factories, or base classes that weren't explicitly in the requirements are noise. Delete them.
- **No new dependencies if avoidable** — prefer `node:fs` over `fs-extra`, `fetch` over `axios`, built-in test runner over Jest.
- **Deletion over addition** — when in doubt, remove lines. Every line that ships is a line that must be maintained.
- **Boring over clever** — simple loops beat functional pipelines, switch statements beat reflection, plain objects beat metaprogramming.
- **Mark with `ponytail:` comments** — annotate intentional simplifications so reviewers know the shortcut was deliberate.
- **Do NOT compromise on security, input validation, or error handling** — Ponytail is about code volume, not correctness.

### Handoff blockers

Only add a blocker in `context_handoff save` when an actual problem blocks progress. An empty/absent `blocker` field lets `/ped-next` advance the pipeline. Placeholder blockers like "N/A" or "No blockers" are stripped automatically.

---

## Token Cost

New conversation overhead: **~3,700 tokens** (1.9% of 200K context).

| Component | Tokens |
|-----------|--------|
| 7 pipeline skill registrations | ~850 |
| 26 tool schemas (16 CE + 10 built-in) | ~2,860 |
| Skill context (per user invocation) | ~300–1,200 |

Progressive loading: only needed skills loaded on-demand.

---

## Generated Structure

```text
your-project/
├── docs/
│   ├── brainstorms/      # Requirements
│   ├── plans/             # Execution plans
│   ├── reviews/           # Review findings reports
│   ├── adr/               # Architecture decisions (lazy)
│   └── solutions/         # Knowledge cards
├── prompts/              # Workflow prompt templates (ped-commit, ped-create-issue, ped-open-pr)
└── .context/
    └── compound-engineering/
        ├── checkpoints/       # Breakpoint files
        ├── handoffs/          # Cross-stage context
        ├── history/           # Execution history
        ├── triage/            # Failure triage records (latest.json + history.jsonl)
        ├── checklist.json     # Persistent task list
        ├── context-state.json # Current workflow stage
        ├── active-stage.json  # Guard's persisted active stage
        ├── stage-reports/     # Per-stage completion reports
        ├── stage-gates/       # Stage-gate verdict records (content-hashed)
        ├── routing/           # Per-stage model-routing decisions (role, reason, scores)
        ├── handoff-readiness/ # Per-pair readiness records + shadow log (content-hashed)
        ├── drift/             # Per-stage drift verdict records (latest state)
        ├── drift.jsonl        # Drift shadow-judgment log (rotated at 1 MiB)
        ├── injection-screens.jsonl # Untrusted-tool-result provenance records
        └── jev-stage-guard.jsonl # Bash guard shadow verdict log (rotated at 1 MiB)
```

Commit everything to git — these files are the project's traceable memory.

---

## Architecture

| Component | Count |
|-----------|------:|
| Skills | 7 |
| Tools | 16 CE + 10 Pi built-in |
| Rules | 79 |
| TypeScript lines | ~43,386 |
| Tests | 1251 (1249 pass + 2 opt-in skip) (4,053 assertions) |

Rules in `rules/` cover 11 common topics + language-specific sets (TypeScript, Rust, Go, Python, Java, Kotlin, C++, C#, Dart, Swift, Perl, PHP). Project-level overrides take priority.

---

## Internal Subsystems

`extensions/ce-core/stage-gate/` implements the stage completion gate: pure per-stage
rubrics, repo-confined artifact resolution with a content-hash freshness store, and a
save-side guard that `context_handoff save` consults on cross-stage completion saves. The
`stage_gate` tool exposes it to the model (issue
[#5](https://github.com/pedrozadotdev/pi-pedstack/issues/5)).

`extensions/ce-core/jev/` is the typed transport and runtime for CommandCode's headless
`typesafe/jev` decision model (Noul / Choice / Score questions over stdin). It registers
**no Pi tool** of its own and adds **no dependency**; it is consumed by the stage gate, by
the solution-ranking engine behind the `solution_search` tool and optional stage
auto-injection, by the model-role routing resolver at stage entry
(`extensions/ce-core/utils/model-routing.ts`), by the bash stage guard
(`extensions/ce-core/utils/stage-guard-runtime.ts`) for the bounded semantic fallback on
commands the deterministic classifier cannot prove, by the handoff-readiness save
guard (`extensions/ce-core/handoff-readiness/guard.ts`), and by the failure-triage
`tool_result` handler — all through an injected runtime so its validated
spawn/parse/error path is shared and testable (issue
[#2](https://github.com/pedrozadotdev/pi-pedstack/issues/2)).

The handoff-readiness subsystem (`extensions/ce-core/handoff-readiness/`) is a
parallel save-side guard to the stage-gate one. `combine.ts` holds the frozen
types, the deterministic pre-pass, the byte-bounded Jev request, and the verdict
derivation; `store.ts` persists one content-hashed record per stage pair and the
shadow log under `.context/compound-engineering/`; `guard.ts` orchestrates the
authoritative order — deterministic floor, then pre-pass, then freshness reuse,
then Jev — with all I/O injected. `context_handoff save` consults it on
cross-stage completion saves and `context_handoff validate` reads a record back
advisorily, never calling Jev (issue
[#10](https://github.com/pedrozadotdev/pi-pedstack/issues/10)).

The overengineering subsystem (`extensions/ce-core/overengineering/`) supplies the stage
gate with the two things it lacked — a per-stage baseline and deterministic complexity
facts — for four floor-only semantic dimensions. `baseline.ts` resolves the per-stage
normative excerpt from files only; `facts.ts` is pure diff/manifest/untracked extraction
behind an injected git runner; `compose.ts` resolves the mode and baseline first, then
degrades to `unavailable` rather than throwing; `shadow-log.ts` appends the D10
calibration records. The four dimensions are excluded from `weightedAverage` and can only
lower a verdict through `OVERENGINEERING_FLOOR = 0.5` (issue
[#16](https://github.com/pedrozadotdev/pi-pedstack/issues/16)).

The failure-triage subsystem (`extensions/ce-core/tools/failure-triage.ts`,
`failure-triage-runner.ts`, `triage-store.ts`) registers no Pi tool either. It runs as a
fourth `tool_result` handler: on a failed verification command it bounds the failure
excerpt, classifies it with Jev (2.5 s cap), degrades to a keyword heuristic on outage or
abstention, annotates the result in place, and persists the record. It is advisory only —
it never returns `isError`, mutates code, or changes the command's exit status, and it
fails open on any internal error.

## Commands

| Command | Description |
|---------|-------------|
| `bun test` | Run all tests |
| `/ped-start <prompt>` | Start a new Pedstack workflow with a user prompt, launching 01-brainstorm |
| `/ped-next [prompt]` | Auto-resolve and advance to the next pipeline stage |
| `/ped-reload` | Restart the current pipeline stage from a fresh context, re-applying skill config |
| `/ped-fix-issues <#1,#2,...>` | Prompt-inject GitHub issue context into 01-brainstorm |
| `/ped-debug <prompt>` | Enter 04-5-debug on demand with gating (warns if before 04-review). Prompt is required. |

Auto-advance: `/ped-next` is automatically queued after every successful handoff save, except for two gated transitions (`02-plan→03-work` and `04-review→05-learn`) which prompt for confirmation. The authorization persists per-session.

---

## Links

- **GitHub**: <https://github.com/pedrozadotdev/pi-pedstack>
- **License**: MIT

---

## Credits

This project is based on the [super-pi tools](https://github.com/leing2021/super-pi/tree/main/extensions/ce-core/tools) project.
