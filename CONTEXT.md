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
- **Mode** — `PEDSTACK_DOCS_VERIFICATION = off | shadow | enforce` (default `shadow`);
  `PEDSTACK_DOCS_VERIFICATION_FAILCLOSED=1` opts into blocking in `enforce` on a degraded
  semantic layer (default `0`, fail-open).
