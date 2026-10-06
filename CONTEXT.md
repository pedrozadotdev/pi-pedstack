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
