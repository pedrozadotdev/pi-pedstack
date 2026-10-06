---
title: One Freshness Predicate, Reused at Every Read Site — Never Reimplemented Weaker
category: architecture
severity: medium
tags:
  - pedstack
  - handoff-readiness
  - freshness
  - persisted-record
  - content-hash
  - source-provenance
  - degraded-mode
  - stale-record
  - read-site
  - single-source-of-truth
  - advisory-surface
  - validate
  - jev
  - stage-gate
applies_when:
  - A persisted record carries a hash/source/thresholds-version and has more than one reader
  - A record is written by a gate and later surfaced (advisory) or consumed (enforcing) elsewhere
  - A degraded or deterministic fallback persists a record with a real verdict value
  - Adding a second entry point that must decide "is this record still trustworthy?"
  - Reviewing whether a stale or degraded record can reach a consumer
---

# Problem

A persisted readiness record is trustworthy only if it passes one predicate —
recomputed payload hash **and** matching stage pair **and** matching thresholds
version **and** `source === "jev"`. The writer path used that predicate
(`isRecordFresh`). The reader path (`context_handoff validate`) re-implemented a
**weaker** check inline and shipped stale and degraded verdicts as if they were
fresh.

```text
extensions/ce-core/handoff-readiness/store.ts:157   isRecordFresh(record, hash, pair)
  -> schema === 1 && pair && hash === hash && thresholdsVersion === V && source === "jev"

extensions/ce-core/tools/context-handoff.ts:539     surfaceReadiness(...)
  -> if (record.pair !== pair || record.thresholdsVersion !== THRESHOLDS_VERSION) return undefined
     // no hash recompute, no source check
```

Two concrete consumer-visible bugs fell out of the same root cause:

1. **Stale record surfaced as fresh.** Edit `handoffMarkdown` after a save; the
   same pair/version still matched, so the old `continue` verdict was returned
   instead of no verdict. The requirement said "never a stale one".
2. **Degraded fallback surfaced as a judgment.** A Jev outage persists a record
   with `verdict: "improve_handoff"`, `source: "degraded"`
   (`guard.ts:91` `degradedOutcome`). `surfaceReadiness` returned it with no
   source check, so a pure infrastructure timeout looked like a real
   "improve your handoff" verdict.

# Context

This surfaced in `pi-pedstack` during `04-review` of issue #10 (semantic
handoff-readiness validation). The guard (`handoff-readiness/guard.ts`) computes
the replayable hash at line 241 and reuses a record only through `isRecordFresh`.
The advisory `validate` surface lives in a different module
(`tools/context-handoff.ts`) and had been written to "read the latest record for
this pair", so it compared only the two fields it happened to have in hand.

The same review found a sibling defect in the *writer*: the pre-pass checked only
`activeFiles`, not the union with `recentlyAccessedFiles`, so a handoff whose
recent files were all deleted could still be judged `continue`. That one is a
requirements↔plan divergence
([`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md));
this card is the read-site twin.

It matters because this record is gate-adjacent: today the surface is advisory,
but the same freshness question decides a save-block once `enforce` is trusted.
A read site that answers it more loosely than the gate is exactly how an
`enforce` mode becomes either a deadlock (over-strict) or a hole (under-strict).

# Solution

## 1. Make the predicate the only way to ask the question

Export one function per record type and call it from **every** read site — the
gate, the advisory surface, and any future consumer. The signature must be
impossible to call without supplying the inputs freshness depends on:

```typescript
// store.ts — the single definition
export function isRecordFresh(
  record: ReadinessRecord | null,
  hash: string,   // recomputed from the same canonical state
  pair: string,
): boolean {
  if (!record) return false;
  return (
    record.schema === 1 &&
    record.pair === pair &&
    record.hash === hash &&
    record.thresholdsVersion === THRESHOLDS_VERSION &&
    record.source === "jev"
  );
}
```

If a read site cannot recompute the hash (it lacks the state), then it cannot
answer "is this fresh?" and must return no verdict — not a partial answer. Pass
the *state reconstruction* into the surface instead of the record alone.

## 2. Reconstruct the same state at the read site

`surfaceReadiness` must rebuild the exact `ReadinessState` the save used — from
the resolved pair, current `context-state.json`, and the handoff markdown — then
call `isRecordFresh(record, recomputeHash(state), pair)`. That also enforces
`source === "jev"` for free, so a degraded record can never surface as a verdict.

## 3. Prove both directions with RED tests

```text
edit handoffMarkdown after a save        -> validate returns NO readiness
seed a record with source: "degraded"    -> validate returns NO readiness
seed a record with source: "deterministic" -> validate returns NO readiness
unchanged handoff + source: "jev"        -> validate returns the verdict
```

The existing tests only exercised the happy path (`fresh record → verdict`), so
the weaker predicate was invisible to a green suite.

# Why this works

- **Freshness is a property of the (record, current inputs) pair, not of the
  record alone.** The record can only be judged against a recomputed hash. Any
  predicate that omits the hash is answering a *different* question ("does a
  record exist for this pair and version?"), and that answer is not fresh.
- **A second definition is a second contract.** Two predicates over the same
  lifecycle will drift; the read site had no reason to change when the writer
  tightened. A single exported function makes the writer's correctness the
  reader's correctness.
- **Provenance is part of freshness for fallback-bearing records.** When a
  degraded path writes the same field as the primary path, "is it fresh?" and
  "is it real?" are the same gate. Enforcing `source === "jev"` inside the
  predicate keeps that coupling in one place (the sibling rule is
  [`keep-degraded-fallbacks-out-of-primary-signal-state.md`](keep-degraded-fallbacks-out-of-primary-signal-state.md)).
- **Failing closed to "no verdict" is always available.** An advisory surface
  that cannot recompute freshness returns nothing — strictly safer than
  returning a possibly-stale verdict.

# Prevention

- When adding a persisted record, write the freshness predicate and make it the
  *only* exported check; every consumer imports it. A second implementation is a
  review finding.
- For every new entry point ("surface", "status", "replay"), ask: *can this path
  reconstruct the hash the writer used?* If not, it returns no verdict rather
  than a weaker one.
- If a record has a `source`/provenance field, include the primary-source check
  inside the freshness predicate, not at each call site.
- Add a RED test per read site for **stale hash** and **degraded source**; a
  happy-path round trip does not exercise the predicate's discriminators.
- Cross-check the gate's own freshness rule: the stage-gate card's section 4
  ([`../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`](../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md))
  covers the writer side ("a hash is only a proof if both ends resolve
  identically"); this card covers the reader side ("the predicate must be reused,
  not re-derived").

## Related solutions

- `docs/solutions/workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`
  — the writer-side freshness rule (replay the same resolution) and the
  content-hash record shape this card reads.
- `docs/solutions/architecture/keep-degraded-fallbacks-out-of-primary-signal-state.md`
  — why a degraded fallback must not occupy primary-signal state; `source` is the
  discriminator this predicate enforces.
- `docs/solutions/architecture/sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`
  — the analogous "apply the one transformation/check at **every** consumer"
  pattern for a value that must not be duplicated per sink.
- `docs/solutions/workflow/requirements-vs-plan-signature-divergence.md`
  — the writer-side divergence found in the same review (pre-pass narrowed to
  `activeFiles` only).

## Downstream Impact

### For 02-plan

- When a plan introduces a persisted record, name its freshness predicate in the
  frozen signatures and list **every** read site that must call it.
- Add a test row per read site: `stale hash → no verdict`, `degraded source → no
  verdict`. A single "happy round trip" row is not coverage.

### For 04-review

- For every persisted record, grep its readers and check each one calls the
  shared freshness predicate. Readers that inline a subset (`pair` +
  `thresholdsVersion`) are findings even when the suite is green.
- Probe stale and degraded records directly instead of only re-reading the diff.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-semantic-handoff-readiness-validation.md`
  (Moderate: `validate` surfaces stale/degraded records).
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T03-36-50-544Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-06-semantic-handoff-readiness-validation-requirements.md`
  ("Surfacing from `validate`" / "Fresh iff recomputed payload hash … and `source`").
- **Plan:** `docs/plans/2026-10-06-semantic-handoff-readiness-validation.md` (Unit 4 / Unit 6).
- **Source files:** `extensions/ce-core/handoff-readiness/store.ts`,
  `extensions/ce-core/handoff-readiness/guard.ts`,
  `extensions/ce-core/tools/context-handoff.ts`.
- **Status:** fix deferred to `04-5-debug`; advisory-only today, becomes
  gate-integrity-critical once `enforce` is trusted.

## 🧠 Context Status

- **Health:** good — the module is shadow-first; the finding is documented and
  does not block advancement to `06-docsync`.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/handoff-readiness/store.ts`,
  `extensions/ce-core/handoff-readiness/guard.ts`,
  `extensions/ce-core/tools/context-handoff.ts`.
- **Recommendation for `06-docsync`:** link this card from the handoff-readiness
  env/docs surface; do not trust `enforce` until `surfaceReadiness` calls
  `isRecordFresh`.
