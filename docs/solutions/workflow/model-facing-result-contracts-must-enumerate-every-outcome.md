---
title: Model-Facing Result Contracts Must Enumerate Every Outcome
category: workflow
severity: medium
tags:
  - pi-extension
  - tool-result
  - status-ladder
  - partial
  - degraded
  - zero-answer
  - telemetry
  - early-return
  - model-facing
  - observability
  - semantic-scout
  - pedstack
applies_when:
  - A model-facing tool returns a status enum (ok/partial/error/degraded/none)
  - Some (answers, failures) combinations are possible but not represented in the status ladder
  - A deterministic fact (byte size, count) is used as telemetry but computed after an early return
  - Input-error messages are computed then discarded so the model sees only an error code
---

# Problem

A status field is a contract with the caller. When the ladder is written as
`if`/`else if` that enumerates only some `(answers, failures)` combinations, an
unlisted combination falls through to a catch-all label that *reads* richer than
it is, and a caller (often an LLM) acts on the wrong story. The
`semantic_scout` engine (`extensions/ce-core/utils/semantic-file-ask.ts`) showed
three faces of the same gap:

1. **Zero answers, no outage → `partial`.** `summarizeAttempts`
   (`semantic-file-ask.ts:1083`) had
   `if (answered === 0 && outage) "degraded"; else if (answered === 0) "partial";`.
   A scout over only binary/empty files returned `status: "partial"`,
   `counts.answered: 0`, and no `guidance` — even though the requirement defines
   `partial` as "≥ 1 answer and ≥ 1 per-path failure". The model can read
   "partial" as "some answers exist" and skip the fallback.
2. **Telemetry dropped on the early-return path.** `readExcerpt`
   (`semantic-file-ask.ts:328-339`) returns `fileBytes: 0` for binary/empty files
   *before* `statSync`, so a 500-byte `image.png` reported `fileBytes: 0` and
   `savings.totalFileBytes` under-counted. A fact used as telemetry must be
   populated on **every** return path, including deny-list rejections.
3. **Computed messages discarded.** `failure(rel, reason, message)` did
   `void message; return { status:"error", path:rel, reason }`
   (`semantic-file-ask.ts:495`), so `invalid_question` / `invalid_criteria`
   surfaced only a code; the actionable detail
   (`"score criteria must contain 2..10 levels"`) never reached the model.

The throughput cost is low; the cost is a **wrong mental model** — the tool
answered fewer paths than the status implies, reported less data than it
measured, or hid the one string that would let the model fix its own call.

# Context

`semantic_scout` answers a bounded question per candidate and must never return a
body, never throw, and never return an unexplained empty list. Requirement R8
requires explicit partial failure isolation and R9 requires an explicit
`degraded` + read/grep fallback on outage. The review found the outage path
correct and the *non-outage zero-answer* and *telemetry/actionability* paths
underspecified (M2 Moderate; M3, L1 Low after audit reclassification).

Related: [`../architecture/apply-traversal-policy-to-expansion-roots.md`](../architecture/apply-traversal-policy-to-expansion-roots.md)
is the candidate-set half of the same feature; this card is the result half.

# Solution

**Treat the status ladder as total: enumerate every combination of (answers,
failures, outage), and attach a message to any status that is not self-evident.**

```ts
// Total ladder: every branch is reachable by construction and explicit.
if (attempts.length === 0)            status = "error";    // nothing to attempt
else if (answered === 0 && outage)    status = "degraded"; // outage fallback
else if (answered === 0)              status = "empty";    // zero answers, NOT outage
else if (failed > 0)                  status = "partial";  // ≥1 answer, ≥1 failure
else                                  status = "ok";
```

Add a `message` for the non-obvious branch (`"no path produced an answer; N
binary/empty/unsafe paths were skipped"`) so the caller does not have to infer it
from `counts.answered === 0`.

**Populate deterministic facts before every return:**

```ts
function readExcerpt(abs: string, rel: string): ExcerptResult {
  const size = safeSize(abs);            // statSync once, first
  const ext = path.extname(rel).toLowerCase();
  if (BINARY_EXT.has(ext))
    return { ok: false, reason: "binary", message: "binary file extension", fileBytes: size };
  // …size is present on the deny path too
}
```

**Keep the structured result frozen; surface discarded detail in the text
formatter.** The fix for the dropped `message` is presentation-level: include the
bounded message in the tool's text rendering for input errors without widening
the typed result.

# Why this works

- **A total ladder has no fall-through.** Enumerating all combinations forces the
  author to *name* the zero-answer non-outage case instead of inheriting a
  neighbour's semantics. The pathological branch becomes a decision with a test.
- **Telemetry is data, not decoration.** `totalFileBytes` / `savings` are read as
  facts; a `0` from an unpopulated path is a silent lie, not a missing optional.
  Computing the stat before the reject makes the fact total.
- **The model is the consumer.** For a model-facing tool, an error code alone is
  not actionable; the one-line reason is what lets the model correct the call
  (e.g. supply 2–10 score levels) without a human.

# Prevention

- **Draw the status ladder as a table** of `(answers, failures, outage)` →
  status, and require every row to be reachable/tested. If a branch reads like a
  catch-all (`else`), ask which real case lands there.
- **List "essential facts computed by this function" and assert they are set on
  every return path** — including early rejects in deny/binary/empty branches.
- **For every `void message`/`void reason`-style discard, ask whether the caller
  needs it.** If yes, thread it through the text formatter (keep the structured
  result stable).
- **Add tests for the awkward combinations**: all-binary input (zero answers, no
  outage), all-unsafe paths, and an invalid-question call that must surface the
  detail.

## Downstream Impact

### For 02-plan

- When a unit returns a status enum, put the *status table* in the frozen
  signature block and require a test row per combination.
- Add a "telemetry total on all return paths" checkbox to any unit that reports
  sizes/counts/savings.
- For tool-facing units, plan the text formatter separately so input-error
  detail has a home that does not widen the typed result.

### For 04-review

- **Flag status ladders with an unenumerated catch-all** and require the
  zero-answer, non-outage case (and any other missing row) to be named and tested.
- **Flag facts reported by the tool that are `0`/absent on an early-return path**
  (sizes, counts, durations) — trace each one to a single pre-branch computation.
- **Flag computed-then-discarded messages** (`void message`) on model-facing
  tools; request the detail in the text formatter.

## Related solutions

**Overlap check:** no High-overlap card exists (new artifact, distinct root cause).
Closest existing cards: `bulk-api-design-for-model-facing-tools` (Moderate — same
model-facing tool surface, but governs input batching while this governs the result the
model reads) and `shadow-first-semantic-ranking-with-deterministic-fallback` (Low — shared
status/fallback vocabulary). Created new rather than updated.

- [`../architecture/apply-traversal-policy-to-expansion-roots.md`](../architecture/apply-traversal-policy-to-expansion-roots.md)
  — the candidate-set half of the same feature; both are "the contract must hold
  on every path, not just the representative one".
- [`../workflow/bulk-api-design-for-model-facing-tools.md`](./bulk-api-design-for-model-facing-tools.md)
  — the sibling model-facing tool ergonomics card; this card governs the *result*
  the model reads, that one governs the *input* the model sends.
- [`../architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md`](../architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md)
  — the `degraded`/`prior` fallback contract this ladder must stay consistent
  with; both require the fallback to be a tested, named status.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
  (Findings M2 zero-answer `partial`, M3 binary `fileBytes: 0`, L1 discarded
  input-error message; L3 `timedOut` per-path vs total is the same class)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T21-12-11-357Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting-requirements.md` (R7 bounds, R8 partial isolation, R9 outage guidance)
- **Plan:** `docs/plans/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting-plan.md` (Units 3–5)
- **Source files:** `extensions/ce-core/utils/semantic-file-ask.ts` (`readExcerpt`, `failure`, `summarizeAttempts`), `extensions/ce-core/tools/semantic-scout.ts`
- **Status:** findings deferred to an on-demand `04-5-debug` pass; the tools are new and unreleased.

## 🧠 Context Status

- **Health:** good — the result-contract learning is captured; the M2/M3/L1 fixes
  are time-boxed to an on-demand `04-5-debug` pass.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/workflow/model-facing-result-contracts-must-enumerate-every-outcome.md`,
  `extensions/ce-core/utils/semantic-file-ask.ts`,
  `extensions/ce-core/tools/semantic-scout.ts`,
  `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
- **Recommendation for `06-docsync`:** carry the status-ladder/telemetry rules
  into `CONTEXT.md` semantic-scouting vocabulary and note the deferred fixes in
  the docs sync.
