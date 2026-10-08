# CONTEXT.md — pi-pedstack

Canonical domain vocabulary for this repository. When these terms are used in
brainstorms, plans, reviews, or code, they mean exactly this.

## Workflow

- **Stage** — one step of the strict pipeline: `01-brainstorm` → `02-plan` →
  `03-work` → `04-review`. A review with confirmed findings routes back to `03-work`
  and must be reviewed again; only a clean review continues to `05-learn` → `06-docsync`.
  `04-5-debug` remains on-demand via `/ped-debug`. Unresolved findings are never skipped.
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
  (isolated reviewer; may reuse the SOTA model id), or `sota` (highest-capability escalation), declared once
  in the required top-level `models` block.
- **Execution role** — the role actually applied to a stage turn: `default | sota` only.
  `review` is never an execution target.
- **Routing decision** — the persisted `{ role, reason, source, scores, weighted, confidence,
  attempts, escalations, revisions, reviews }` produced at stage entry. `reason` is one of
  `override | gate_escalate | jev | budget_exhausted | stage_policy | fallback`; `source` is one of
  `override | deterministic | jev | budget | fallback`. `revisions`/`reviews` count the
  retained stage-gate attempts with those verdicts (bounded by the stage-gate
  `ATTEMPT_CAP = 3`); a legacy record without them reads as `0`.
- **Stage eligibility** — only `01-brainstorm`, `02-plan`, and `04-5-debug` may select `sota` automatically. `03-work`, `04-review`, `05-learn`, and `06-docsync` stay on the default role; they keep their quality gates/revision loops and ignore old escalation records. A deliberate per-stage model override still wins.
- **Deterministic escalation** — a `sota` choice justified by the newest stage-gate
  `escalate` verdict, independent of Jev; it short-circuits any Jev call.
- **Escalation budget** — `routing.maxEscalationsPerStage` (default 1): a cost cap on
  **proactive Jev-triggered** `sota` selections. A Jev judgment that would select `sota`
  after the budget is spent is recorded as `budget_exhausted`/`budget`, never `fallback`, so
  a spend cap is distinguishable from an outage. Deterministic stage-gate escalation is
  exempt: it is honored even when the budget is exhausted. The budget is workflow-scoped:
  `/ped-start` and `/ped-fix-issues` clear the previous workflow's routing and stage-gate
  records, while `/ped-next`, `/ped-reload`, and `/ped-debug` preserve them.
- **Eligible stage-gate escalation** — when an eligible stage returns `action: "escalate"`, the stage loop stops; enforced routing automatically reloads it under `models.sota` at the end of the turn. `/ped-reload` remains the manual fallback if automation cannot start. Shadow mode records the decision but does not switch models; no model is changed mid-turn. This does not apply to work, review, learn, or docsync.
- **Enforced-by-default routing** — `routing.shadow` defaults `false`: stage-entry routing applies
  `models.default` or (where eligible) `models.sota` without requiring a `routing` block.
  `models` is the only required config block when a config file exists; all other blocks are optional.
  Set `routing.shadow: true` to log decisions without applying them. The choice is reversible.
- **Per-stage override** — an explicit `model`/`thinkingLevel` under a stage key
  (`brainstorm`, `plan`, `work`, `review`, `debug`, `learn`, `docsync`). It wins verbatim over
  stage-gate escalation and Jev routing as an intentional operator override; the three
  `models` roles are the normal configuration style.

## Conditional review loop (#7)

- **Review action** — the bounded `ReviewAction` (`none | revise | review | escalate`) the
  `stage_gate` derives in TypeScript from the verdict, the retained budget, and reviewer
  availability: `accept → none`, `revise → revise`, `escalate → escalate`,
  `review → review` (one reviewer) or `→ escalate` when the budget is spent or no
  independent reviewer resolves.
- **Review budget** — `MAX_INDEPENDENT_REVIEW = 1`: at most one independent review per stage
  loop, counted from the retained prior attempts whose verdict is `review` since the newest
  `accept`. A second `review` maps to `escalate`.
- **Independent reviewer** — an isolated reviewer invocation: `multi_reviewer` runs in a
  separate no-session process with a reviewer-specific prompt. The review model may reuse the
  same model id as `models.sota`, `models.default`, or a per-stage execution override;
  model-id equality does not make the reviewer unavailable. A stage with no configured reviewer
  at all still maps `review → escalate` with a reason, so an unconfigured operator cannot deadlock.
- **Findings freshness** — a findings sidecar satisfies a `review` demand only when its
  `observedAt` (`generatedAt`, else the file mtime) is on or after the demanding gate
  record's `updatedAt`. A sidecar predating the demand is stale and contributes no review
  demand; a well-formed `count: 0` sidecar still satisfies a fresh demand.

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
- **Screen mode** — `off | shadow | enforce`, resolved from `features.injectionScreen.mode`
  once at init; omitted values default to `enforce`; invalid values are rejected by config validation.
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
  when explicitly selected. `features.handoffReadiness.mode = "off" | "shadow" | "enforce"` defaults to `enforce`.

## Docs verification (#15)

- **Docs-verification obligation** — a persisted, per-unit record that a unit requires
  authoritative `contextqmd` verification and has not yet produced compact evidence;
  `open` until `satisfied` (a validated `docs-verified:` line) or `waived` (operator
  reason). A waived obligation re-opens when the unit content hash changes.
- **Evaluation unit** — one `### Unit` block extracted from the active plan, identified
  by a stable slug (carry-over identity) and a content hash (dedupe key).
- **Unit facts** — deterministic TypeScript facts for a unit: touched external packages,
  version facts, declared files, existing evidence, and phase (`planned` at `02-plan`,
  `observed` at `03-work`). Facts are computed in code, never by Jev.
- **Docs decision** — the TypeScript-derived value `not_required | required | uncertain`;
  Jev only answers the three bounded `noul` questions (`external_api_dependence`,
  `version_sensitivity`, `verification_material`) and never derives the decision.
- **Compact evidence** — a bounded `docs-verified: PACKAGE@VERSION DOC_REF` line naming a
  detected package, the matching version (or `unknown` when the fact is version-unknown),
  and a `contextqmd` doc path or page UID; format plus package/version match only, never
  content match.
- **Fallback evidence** — a `docs-verified:` line accepted while Jev is degraded, recorded
  `source: "fallback"` and re-scored on recovery.
- **Untrusted plan prose** — the active plan is agent-authored free text, not typed data. A
  backticked token is only a candidate package; it is promoted to a fact by intersection with the
  nearest manifest, never by a regex allowlist alone. A declared `Files` path is contained
  (`canonicalRel`/`isInside`) before any `exists`/`readFile`/hash.
- **Mode** — `features.docsVerification.mode = "off" | "shadow" | "enforce"` (default `enforce`);
  `features.docsVerification.failClosed = true` opts into blocking in `enforce` on a degraded
  semantic layer (default `false`, fail-open).

## Stage drift (#8)

- **Stage drift** — a turn that stops honoring the active stage's mandate **without
  making a forbidden tool call** (e.g. `02-plan` starts implementing, `04-review` edits
  the code it reviews). Detected at each `turn_end` from the turn's own facts; distinct
  from the deterministic capability matrix (#3) and the bash stage guard (#4), which
  only act on a specific call's effect.
- **Drift dimension** — one of the four independent `noul` judgments:
  `in_stage_scope`, `forbidden_work`, `scope_drift`, `progress`. Jev answers the
  dimensions; TypeScript derives the verdict. `forbidden_work` is **tiered**: `>= 0.60`
  is a mild signal (counted once), and only `>= 0.80` with confidence `>= 0.60` is
  hard-strong. `progress` is **supporting-only** and never triggers.
- **Drift verdict** — `no_drift | mild_drift | strong_drift`, always derived in
  TypeScript (`extensions/ce-core/drift/combine.ts`). Two soft signals, a strong
  `forbidden_work` (`>= 0.80` with confidence `>= 0.60`), or a repeated mild turn
  (`MILD_REPEAT_LIMIT`) is strong; a single soft signal is mild. Every answer must be a
  finite `noul` in `[0,1]` with confidence `>= MIN_CONFIDENCE` (0.50) or the whole set
  degrades. `THRESHOLDS_VERSION = 2` invalidates every v1 record/status. See the
  [frozen-decision-table drift card](docs/solutions/workflow/frozen-decision-tables-drift-from-implemented-constants.md).
- **Drift correction** — the one-shot, in-session message delivered on the next
  `before_agent_start` for a mild drift turn (enforce only). Newest overwrites; it is
  consumed exactly once and never forces a model continuation.
- **Unresolved drift** — a persisted `strong_drift` verdict for the current stage and
  session that has not been cleared. It blocks a cross-stage `context_handoff save` in
  `enforce`; `shadow` writes no record, so it only warns when a prior `enforce` run
  left one. It clears on a Jev `no_drift` turn that writes the stage artifact, or after
  two consecutive Jev `no_drift` turns.
- **Turn signature** — the hash of the compact turn state (stage, mandate, actions,
  excerpt). An unchanged signature reuses the last judged outcome without a second Jev
  call (`source: "deterministic"`, reason `unchanged turn`).
- **Drift mode** — `off | shadow | enforce`, resolved from `features.driftGuard.mode` once
  at init; omitted values default to `enforce`; invalid values are rejected by config validation. Only `enforce` blocks or
  injects.
- **Drift record** — the latest **state** (not a hash-fresh judgment) written by a Jev
  verdict for one stage, at `.context/compound-engineering/drift/<stage>.json`. Fresh
  means `schema`, `stage`, `sessionKey`, and `thresholdsVersion` match, `source` is
  `jev`, and the record is within the **6 h TTL**. Only a `source === "jev"` verdict
  writes or clears it; degraded/deterministic turns log only, and `shadow` writes no
  record.
- **Drift status** — the per-stage last-evaluation health marker written only by an
  `enforce` turn with a `jev` or `degraded` outcome, at
  `.context/compound-engineering/drift/<stage>.status.json` (`degraded`, `sessionKey`,
  `thresholdsVersion`, `updatedAt`). It is distinct from the **drift record** (verdict
  state) and the shadow log, and uses the same **6 h TTL** through the one shared
  `isDriftStatusFresh` predicate; a corrupt or unreadable status is absent (fail-open).
- **Narrowed fail-closed** — `features.driftGuard.failClosed = true` blocks a cross-stage
  save in `enforce` only when the status is fresh **and** `degraded === true`. A
  never-judged stage, a session/version mismatch, a TTL-expired status, an empty
  (`"unknown-session"`) key, or a non-degraded last evaluation does **not** block.
- **Shadow promotion** — the documented gate before setting `enforce`: at least 100
  judged turns over a representative multi-stage run, a mild-correction rate below 20%,
  zero false-positive strong verdicts on a labeled in-scope set, and a degraded rate
  below 5%. Promotion is calibrated from the shadow log
  `.context/compound-engineering/drift.jsonl`.

## Semantic compaction (#11)

- **Compaction tier** — `silent | notice | recommend | request`; the TypeScript-derived
  context-pressure level (`silent < 0.60`, `notice < 0.75`, `recommend < 0.90`, `request`
  otherwise) computed in `extensions/ce-core/compaction-guard/facts.ts`. It is **not**
  `ContextHealth`: a one-directional, documented bridge maps `silent→good`, `notice→watch`,
  `recommend→heavy`, `request→critical`, and the two are never used interchangeably in
  logs or `pedstack.ts`.
- **Context pressure** — `tokens / contextWindow`; the deterministic gate that decides
  whether Jev may be called at all.
- **Trigger tokens** — `contextWindow - reserveTokens`, the context-token count at which
  Pi's automatic compaction fires. `headroomTokens` is the reserve that remains.
- **Overage tokens** — `tokensBefore - triggerTokens` (absolute, window-independent), the
  only hook-side defer gate. A defer requires `0 <= overageTokens <= 2000` (about 12% of
  the default 16384 reserve). Because Pi only fires the hook past the trigger, the hook's
  absolute pressure is always ~0.87–0.98, so defer is gated on overage, not an absolute
  floor.
- **Threshold episode** — the span from crossing the trigger to the next successful
  `session_compact`; it defines `consecutiveDefers` and the signature-reuse scope. A
  `session_compact` ends it: `consecutiveDefers`, `lastSignature`, `lastOutcome`, and the
  one-shot request-nudge flag reset, and `lastCompactionAt` is stamped. Session state is in
  memory, keyed by session; only a redacted shadow log is persisted.
- **Good boundary** — the frozen Jev-derived rule
  `(task_switch >= 0.5 OR meaningful_boundary >= 0.5) AND history_need < 0.5 AND
  mid_operation < 0.6`. A good boundary allows compaction; anything else is a defer
  candidate inside the hard guards.
- **Live multi-step operation** — in-flight work whose exact state would be lost if
  summarized; captured by the `mid_operation` and `history_need` dimensions.
- **Defer** — the `enforce`-only `{ cancel: true }` outcome; allowed only inside the
  deterministic hard guards (reason `threshold`, `willRetry` false, `overageTokens` in
  range, the consecutive-defer cap, derived action `defer`). Verified against the installed
  Pi bundle to reschedule at the next threshold check (it does not suppress compaction until
  overflow).
- **Defer budget** — `MAX_CONSECUTIVE_DEFERS = 2`; once reached, the next check allows, so
  a defer can only reschedule, never suppress compaction until overflow.
- **Compaction health bridge** — one-directional tier→health mapping (`silent → good`,
  `notice → watch`, `recommend → heavy`, `request → critical`) feeding
  `context_handoff.contextHealth`. It is never derived from a Jev answer.
- **Context-health provider** — the live `getContextUsage()` read captured per turn and
  consulted by `context_handoff save` when no explicit `contextHealth` is supplied; an
  unexplained `null` never claims `good`.
- **Compaction mode** — `off | shadow | enforce`, resolved from
  `features.compactionGuard.mode` once at init. `shadow` is deterministic-only unless
  `features.compactionGuard.live = true`; only `enforce` returns `{ cancel: true }`. There is
  no fail-closed knob: a degraded semantic layer always allows stock Pi compaction.
- **Module** — `extensions/ce-core/compaction-guard/` (named `compaction-guard`, not
  `context-health`, to avoid colliding with the existing `ContextHealth` type).

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
  `weightedScore` or `verdict` when explicitly selected. `features.overengineering.mode = "off" | "shadow" | "enforce"` defaults to `enforce`.
