# CONTEXT.md — pi-pedstack

Canonical domain vocabulary for this repository. When these terms are used in
brainstorms, plans, reviews, or code, they mean exactly this.

## Workflow

- **Stage** — one step of the strict pipeline: `01-brainstorm` → `02-plan` →
  `03-work` → `04-review` → `05-learn` → `06-docsync`, plus on-demand
  `04-5-debug` (entered via `/ped-debug`). Stages are never skipped or combined.
- **Capability matrix** — the pure TypeScript table (`extensions/ce-core/utils/capability-matrix.ts`)
  that classifies a repo-relative path and decides whether the active stage may write it.
- **Artifact** — a dated workflow document under `docs/` (`brainstorms/`, `plans/`,
  `reviews/`, `solutions/`) or under `.context/` (handoffs, checkpoints, dialogs).
- **Handoff** — the cross-stage evidence package saved by `context_handoff save`;
  advancing requires an empty checklist and (for two transitions) user authorization.
- **Solution card** — a durable learning document under `docs/solutions/<category>/`
  with frontmatter: `title`, `category`, `severity`, `tags[]`, `applies_when[]`.

## Jev (semantic decision layer)

- **Jev** — CommandCode `typesafe/jev`, invoked in headless mode as
  `cmd -p -m typesafe/jev`. A bounded semantic decision layer, never the worker.
- **Runtime** — `extensions/ce-core/jev/` (`createJevRuntime`, `createFakeJevRuntime`).
  The main model is the worker; Pedstack (TypeScript) is the policy authority; Jev is
  the bounded semantic judge.
- **Question types** — `noul` (probability in `[0,1]` + confidence), `choice`
  (one of a fixed set), `score` (graded 2–10 levels).
- **Deterministic facts stay in TypeScript** — severity, category, tags, thresholds,
  paths, and hard gates are never delegated to Jev.
- **Shadow mode** — compute and log a Jev decision without enforcing it, to calibrate
  thresholds on real traces before enforcement.
- **Degraded** — a result produced by the deterministic fallback because Jev was
  unavailable or invalid; never weaker than the original hard gate.

## Solution ranking (#9)

- **Candidate recall** — deterministic selection of at most **N=15** solution cards
  from `docs/solutions/**` using frontmatter first and a bounded body/heading grep
  fallback (when fewer than 3 frontmatter hits).
- **`prior`** — the deterministic TypeScript score from frontmatter facts. It sorts
  and truncates candidates, and it breaks ties in the final ranking.
- **`rankSolutions`** — the single shared entry point
  (`extensions/ce-core/utils/solution-ranking.ts`) used by the model-facing
  `solution_search` tool, by stage auto-injection, and by learn overlap detection.
- **Atomic questions** — the three independent `noul` judgments asked per candidate:
  `relevance`, `applicability`, `reuse`. Combined in TypeScript as
  `rank = relevance × applicability`, with `reuse` as a boost/tie-breaker.
- **Threshold** — inject a card only when `rank ≥ minRank` and
  `confidence ≥ minConfidence` (defaults `0.60` / `0.50`, configurable). No card above
  threshold ⇒ explicit `status: "none"` ("no relevant solution").
- **Overlap detection** — reusing `rankSolutions` with a newly written solution card
  as the query to surface semantically overlapping existing cards (`05-learn`).

## Model roles & routing (#6)

- **Model role** — one of `default` (cheap normal-execution workhorse), `review`
  (independent stronger reviewer), or `sota` (highest-capability escalation), declared once
  in the optional top-level `models` block.
- **Execution role** — the role actually applied to a stage turn: `default | sota` only.
  `review` is never an execution target.
- **Routing decision** — the persisted `{ role, reason, source, scores, weighted, confidence,
  attempts, escalations }` produced at stage entry. `reason` is one of
  `override | gate_escalate | jev | budget_exhausted | fallback`; `source` is one of
  `override | deterministic | jev | budget | fallback`.
- **Deterministic escalation** — a `sota` choice justified by the newest stage-gate
  `escalate` verdict, independent of Jev; it short-circuits any Jev call.
- **Escalation budget** — `routing.maxEscalationsPerStage` (default 1). A Jev judgment that
  would select `sota` after the budget is spent is recorded as `budget_exhausted`/`budget`,
  never `fallback`, so a spend cap is distinguishable from an outage.
- **Shadow-first routing** — `routing.shadow` defaults `true`: the decision is computed and
  persisted while the legacy per-stage model is still applied. Routing runs at all only when
  a `models` or `routing` block exists.

## Semantic file scouting (#14)

- **Semantic read** — the `semantic_read` tool: one repo-relative file, one bounded
  question, one typed answer plus byte facts; never a file body.
- **Semantic scout** — the `semantic_scout` tool: expands files/dirs/globs into a
  deduped candidate set, answers each within one deadline, reports counts/savings, and
  optionally recommends the first file to open.
- **Excerpt budget** — the per-path UTF-8 byte cap (default 4096) sent to Jev; the full
  body is never returned to the model.
- **Traversal policy** — directory/file pruning (`.git`, `node_modules`, build dirs,
  lock/minified/generated files) and containment (reject any path or symlink target
  escaping `repoRoot`) are properties of a path, not of how it was reached: they apply
  at **every expansion entry point** (explicit file/dir target, glob base, walk root),
  not only to discovered children. Directory symlinks are never followed.
- **Status ladder** — the total `semantic_scout` status:
  `ok` (all attempted paths answered) → `partial` (answers + per-path failures, or zero
  answers with no outage) → `empty` (no eligible candidates) / `degraded` (Jev outage,
  with `read`/`grep` guidance) / `error` (invalid target, question, or criteria). The
  single-file `semantic_read` uses `ok | error | degraded`.
- **Recommendation** — the optional `semantic_scout` output choosing the first file to
  open, via a second-pass Jev `choice` (`source: "jev"`) or a deterministic ordering
  (`source: "ordered"`).
- **Outage** — a full Jev failure returns `status: "degraded"` plus explicit
  `read`/`grep` guidance; never weaker than the current workflow.

## Injection screen (#13)

- **Provenance** — the deterministic, non-model classification of where a tool result
  came from: `http`, `gh-issue`, `gh-pr`, `gh-api`, or `external-path`. Anything else
  classifies as `null` and is never screened.
- **Untrusted source** — a provenance kind the injection screen treats as external input.
- **Screen mode** — `off | shadow | enforce`, resolved from `PEDSTACK_INJECTION_SCREEN`
  once at init; default and invalid value resolve to `shadow`.
- **Flagged / clean / degraded** — the three screen outcomes. `degraded` is the
  fail-open result produced when Jev is unavailable; it never adds a warning.
- **Untrusted wrapper** — the fixed deterministic delimiter + warning prefix applied
  only in `enforce` + `flagged` mode; the content inside is never modified.
- **Wrap-miss** — a verdict was produced but phase 2 could not apply the wrapper
  (e.g. a `tool_result` lookup miss); logged and counted, and it fails open.
- **Provisional thresholds** — `noul >= 0.60` and `confidence >= 0.50`, hardcoded in
  TypeScript until shadow calibration justifies changing or externalizing them.

## Handoff readiness (#10)

- **Handoff readiness** — the TypeScript-derived verdict on whether a fresh model can
  continue from a handoff without reconstructing major history. Layered on top of the
  deterministic save floor, which stays authoritative; Jev never overrides a
  deterministic block.
- **Dimension** — one of the five independent `noul` judgments:
  `continuation_sufficiency`, `next_step_clarity`, `verification_support`,
  `blocking_open_decisions`, `history_need` (distinct from the stage gate's
  `SemanticDimension`).
- **Verdict** — `continue | improve_handoff | preserve_current_session`, always derived
  in TypeScript (`extensions/ce-core/handoff-readiness/combine.ts`); only `enforce`
  blocks, `shadow` warns (distinct from the stage gate's `StageGateVerdict`).
- **Correction** — a targeted, in-session-fixable handoff edit addressed to the writer;
  attached only to `improve_handoff` (`preserve_current_session` is not a correction).
- **Thresholds version** — the tag that invalidates every persisted readiness record
  when the value/confidence thresholds change.
- **Degraded** — the fail-open source recorded when Jev is unavailable or returns an
  unusable answer set; non-blocking unless `FAILCLOSED` is set in `enforce`.
- **Shadow mode** — compute, record, and log the readiness verdict without blocking
  (the default). `PEDSTACK_HANDOFF_READINESS = off | shadow | enforce`.

## Stage drift (#8)

- **Stage drift** — a turn that stops honoring the active stage's mandate **without
  making a forbidden tool call** (e.g. `02-plan` starts implementing, `04-review` edits
  the code it reviews). Detected at each `turn_end` from the turn's own facts; distinct
  from the deterministic capability matrix (#3) and the bash stage guard (#4), which
  only act on a specific call's effect.
- **Drift dimension** — one of the four independent `noul` judgments:
  `in_stage_scope`, `forbidden_work`, `scope_drift`, `progress`. Jev answers the
  dimensions; TypeScript derives the verdict. `forbidden_work` is a **hard** signal and
  is excluded from the soft-signal count so one observation never counts twice.
- **Drift verdict** — `no_drift | mild_drift | strong_drift`, always derived in
  TypeScript (`extensions/ce-core/drift/combine.ts`). Two soft signals, a hard
  `forbidden_work`, or a repeated mild turn is strong; a single soft signal is mild.
- **Drift correction** — the one-shot, in-session message delivered on the next
  `before_agent_start` for a mild drift turn (enforce only). Newest overwrites; it is
  consumed exactly once and never forces a model continuation.
- **Unresolved drift** — a persisted `strong_drift` verdict for the current stage and
  session that has not been cleared. It blocks a cross-stage `context_handoff save` in
  `enforce`; `shadow` only warns. It clears on a Jev `no_drift` turn that writes the
  stage artifact, or after two consecutive Jev `no_drift` turns.
- **Turn signature** — the hash of the compact turn state (stage, mandate, actions,
  excerpt). An unchanged signature reuses the last judged outcome without a second Jev
  call (`source: "deterministic"`, reason `unchanged turn`).
- **Drift mode** — `off | shadow | enforce`, resolved from `PEDSTACK_DRIFT_GUARD` once
  at init; default and any invalid value resolve to `shadow`. Only `enforce` blocks or
  injects.
- **Drift record** — the latest **state** (not a hash-fresh judgment) written by a Jev
  verdict for one stage, at `.context/compound-engineering/drift/<stage>.json`. Fresh
  means `schema`, `stage`, `sessionKey`, and `thresholdsVersion` match, `source` is
  `jev`, and the record is within the TTL. Only a `source === "jev"` verdict writes or
  clears it; degraded/deterministic turns log only, and `shadow` writes no record.
- **Shadow promotion** — the documented gate before setting `enforce`: at least 100
  judged turns over a representative multi-stage run, a mild-correction rate below 20%,
  zero false-positive strong verdicts on a labeled in-scope set, and a degraded rate
  below 5%. Promotion is calibrated from the shadow log
  `.context/compound-engineering/drift.jsonl`.

## Overengineering signal (#16)

- **Overengineering signal** — four floor-only semantic dimensions that check whether an
  artifact added only justified complexity. They ride the existing stage-gate Jev request
  (`StageGateAttempt.schema = 2`) and are never a second gate.
- **Dimension** — one of the four ids: `no_unrequested_abstraction`, `scope_fidelity`,
  `complexity_proportionality`, `dependency_justification`.
- **OVERENGINEERING_FLOOR** — `0.5`; any present overengineering dimension below it
  prevents `accept` and routes to `review`/`revise`. The dimensions are excluded from
  `weightedAverage` (floor-only), so a high base average cannot mask them.
- **Baseline** — the per-stage normative excerpt: requirements for `02-plan`, the plan (with
  a contamination guard) for `03-work`, and both for `04-review`. Resolution is file-based;
  the terminal fallback is `unavailable` (never a network fetch).
- **Source** — `jev | unavailable`; `unavailable` means no baseline, all dimensions skipped,
  or a `request_too_large` trim. A skipped dimension is absent from `sem` with a reason in
  `skippedDimensions[]` — never a sentinel score.
- **Shadow mode** — compute, persist, and log the dimensions without changing
  `weightedScore` or `verdict` (the default). `PEDSTACK_OVERENGINEERING = off | shadow | enforce`.
