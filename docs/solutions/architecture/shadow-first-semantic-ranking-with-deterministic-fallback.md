---
title: Shadow-First Semantic Ranking with a Deterministic Fallback that is Never Weaker
category: architecture
severity: high
tags:
  - pi-extension
  - jev
  - semantic-ranking
  - shadow-mode
  - shadow-first
  - deterministic-fallback
  - graceful-degradation
  - bounded-fan-out
  - concurrency
  - request-body-limit
  - conformance-test
  - before-agent-start
  - solution-search
  - single-entry-point
  - pedstack
applies_when:
  - Adding an LLM/semantic scoring layer (ranking, gating, triage) in front of an existing deterministic path
  - Shipping model-dependent behaviour that is not yet calibrated and must not change outcomes on day one
  - Enforcing a hard external request/body size cap where every serialized field counts
  - Designing bounded-parallel fan-out so one bad upstream answer cannot fail the batch
  - Deciding how much of a corpus the main model should read versus a TypeScript pre-filter
---

# Problem

Solution artifacts in `docs/solutions/` are the project's durable learnings, but recall
was performed by the **main model following prose instructions**: grep frontmatter, read
the first 15 lines of *every* candidate, hand-score a rubric, then fully read the top 3.

Two costs compound as the corpus grows:

1. **Context cost** — the main model spends its own window ranking weak candidates before
   doing real work, and the cost scales with the number of cards.
2. **No calibration** — semantic relevance was a judgment call, so there was no way to
   improve recall quality without changing the model or the prose.

The fix is a TypeScript recall + Jev semantic ranking engine. But introducing a
**model-dependent** scoring step creates a new risk: it can be unavailable, slower,
or *worse* than the deterministic path it replaces. The learning is how to ship that step
without ever making the existing path worse.

# Context

Feature #9 ("Jev: semantically rank solution artifacts before context injection",
Milestone D of the Jev runtime work) introduced:

```text
extensions/ce-core/utils/solution-recall.ts   # deterministic recall (no Jev)
extensions/ce-core/utils/solution-ranking.ts  # rankSolutions() — the single entry point
extensions/ce-core/tools/solution-search.ts   # model-facing solution_search tool
extensions/ce-core/utils/solution-query.ts    # auto-injection query builder
extensions/ce-core/utils/solution-wiring.ts   # tool registration + before_agent_start hook
```

The engine is consumed in four pipeline stages (`02-plan`, `04-review`, `04-5-debug`,
`05-learn`), by a model-facing tool, and by a system-prompt auto-injection hook. It relies
on the previously-landed, inert `extensions/ce-core/jev/` runtime and its external
validator (`≤32 questions`, `≤64 KiB` body, scores 2–10, every question answered).

The 04-review pass confirmed the feature works and surfaced the trade-offs below. The
most important discovery was that "shadow mode" and "deterministic fallback" are two
*different* safety mechanisms, and conflating them leaves a gap.

# Solution

## 1. Shadow-first: compute, log, but never enforce

Make the new path **inert by default** and gate injection on an explicit flag:

```typescript
enforced = !shadow;   // DEFAULT_SOLUTION_RANKING.shadow = true
```

In shadow mode the engine still recalls, ranks, and emits one structured record (query
hash, `prior` order, Jev `rank` order, thresholds, drops) — but the auto-injection hook
returns `undefined` and the turn is unchanged. The `solution_search` tool still works, so
the model can opt in while the feature is being calibrated.

```text
Status: ok | none | degraded
- ok       → threshold passed, 1..limit results, ranked
- degraded → Jev failed; thresholds IGNORED, top by deterministic prior
- none     → Jev answered but nothing crossed threshold → 0 results
```

**Exit condition is explicit:** flip `shadow=false` only after a calibration window of
real traces shows the Jev ranking agrees with or beats `prior`. "Ship shadow-first"
without a stated exit condition becomes "never enforce".

## 2. The fallback must be provably never weaker

This is the invariant that makes shadow-first safe to ship:

- `degraded` **ignores** `minRank`/`minConfidence` and returns the top `limit` by the
  pre-existing deterministic `prior` (severity 0.60 + tag overlap 0.30 + category 0.10).
- Sort is stable (`prior` desc, then path asc), so a degraded result is deterministic.
- A full Jev outage therefore yields exactly the pre-Jev behaviour — not zero results,
  not a lower-quality list. Tests pin this (`status: degraded`, `source: "prior"`).

If the fallback dropped below threshold too, a Jev outage would silently remove
context that exists today. That is the regression to prevent.

## 3. One engine, one entry point, two modes

`rankSolutions({ query, repoRoot, jev, thresholds, shadow, limit })` is the *only* entry
point. `mode: "recall" | "overlap"` swaps the atomic `noul` question set
(`relevance`/`applicability`/`reuse` vs `duplicate`/`overlap`/`conflict`) without changing
the mechanics. That keeps one code path for four stages, the tool, the hook, and
`05-learn`'s new-card overlap check.

```text
rank = relevance × applicability;          // reuse is a boost / tie-breaker only
confidence = min(relevance.confidence, applicability.confidence);
qualifies when rank >= minRank && confidence >= minConfidence;
order:  rank desc → reuse desc → prior desc → path asc
```

Policy (thresholds, ordering, status mapping) stays in TypeScript; the model only answers
atomic questions. This is what lets an outage degrade to something *explainable*.

## 4. Bound the fan-out, then isolate each failure

`prior` sorts and truncates to `candidates: 15` **before any Jev call**; then one
`decide()` is issued **per candidate** with `concurrency: 4`, dispatched in `prior` order.

- Worst-case fan-out is ≤15 calls, not one giant batch.
- One timeout/malformed/non-finite answer drops **only that candidate**; the rest remain
  `ok`. A single bad answer never fails the run.
- Dispatching strongest-first means the best candidates are scored even if the run is
  truncated or partially degraded.

## 5. Bound *every* serialized field, not just the obvious excerpt

The external validator enforces a `64 KiB` request cap. The first implementation bounded
the query excerpt (≤2 KiB) and body excerpt (≤4 KiB) and truncated them in an
`enforceRequestBodyLimit()` ladder — but serialized `title`, `category`, `severity`,
`tags`, and `applies_when` **verbatim**. A pathological card could exceed the cap, be
rejected by the real validator, and silently degrade the whole stage.

```typescript
// request body = query excerpt + candidate frontmatter + body excerpt
const MAX_REQUEST_BODY_BYTES = 65_536;
```

**Rule:** when a third party validates a serialized payload, byte-bound *every* field
that goes on the wire, and make the shrink ladder cover each of them. Then prove it:
serialize each generated request and run it through the **real** validator in a
conformance test — no live process needed.

## 6. Reuse the existing injection surface (one handler)

The auto-injection block is composed inside the *existing* `before_agent_start` flow via
a composition hook, not a second handler. `composeSolutionSystemPrompt` returns
`undefined` when nothing is injected and never returns `{ systemPrompt: event.systemPrompt }`
(the no-op that breaks handler chaining). Gating: only the four target stages, skipped
when the assembled query is `undefined`.

## 7. Module-level singletons need a reset

`solution-wiring.ts` holds a module-level `sharedJev`/`sharedJevFactory`. Bun shares
module state across test files in one process, so a fake runtime injected in one test can
leak into a later one (and two extension instances in production would share one runtime).
Provide `resetSolutionWiring()` and call it in `afterEach`; prefer per-registration
dependency injection over a process-wide singleton.

# Why this works

- **Shadow-first decouples "ship the code" from "trust the model."** Compute-and-log
  produces the calibration data needed to earn enforcement, at zero behavioural risk.
- **The fallback invariant is the safety net, not the shadow flag.** Shadow prevents the
  new path from *changing* outcomes; the never-weaker fallback prevents an *outage* from
  removing behaviour. Both are required.
- **Per-candidate requests convert partial failure into expected behaviour.** A batch
  request makes one bad answer fail everything; N independent requests make drops normal,
  which is exactly why the status mapping treats partial drops as `ok`.
- **A deterministic pre-sort bounds cost and preserves quality.** `prior` is cheap,
  explainable, and does the truncation so the expensive semantic step only sees ≤15 items.
- **Conformance beats coverage for external contracts.** Tests written from the plan
  validate the plan; only feeding generated payloads through the real validator catches a
  size/type bound that the implementation forgot.

# Prevention

- **State the enforcement exit condition when you ship shadow mode.** "Shadow-first" is
  only safe if something later flips it. Record the calibration criterion in the plan.
- **Write the fallback contract as a test, not a comment.** Assert `degraded` returns the
  pre-existing ranking, thresholds ignored, `degraded: true`, `source: "prior"`.
- **For any externally-validated payload, enumerate the fields and byte-bound each one.**
  Add a conformance test that runs every generated request through the real validator.
- **Prefer one request per item + bounded concurrency** when partial failure is acceptable;
  reserve batching for cases where the upstream requires it.
- **Keep policy (thresholds/order/status) in TypeScript** and let the model answer only
  atomic questions, so a model change cannot silently change gating semantics.
- **Give every module-level singleton a `reset…()` and call it in `afterEach`.**
- **Treat injected card text as untrusted reference data**, not instructions — auto-
  injection moves solution bodies from the conversation into the system prompt.

# Downstream Impact

### For 02-plan

- When planning any LLM-dependent scoring/gating step, default it to shadow mode and write
  the deterministic fallback contract as an explicit unit (with tests) before the Jev
  integration unit.
- Put the request-size table in the plan's frozen-signature block and require a
  conformance unit that validates generated requests against the real validator.
- Note when `docs/solutions/` cards are being auto-injected: mark injected text as
  untrusted and keep the composition inside the single existing handler.

### For 04-review

- Verify `enforced = !shadow` and that the degraded path ignores thresholds and returns
  the pre-existing deterministic ranking — not an empty list.
- Challenge any serialized request bound: list the fields on the wire and confirm each is
  byte-bounded; ask for the conformance test.
- Flag a second injection handler or a returned `{ systemPrompt: event.systemPrompt }`
  no-op; both break handler chaining.
- Flag module-level singletons without a reset + `afterEach` cleanup.

## Related solutions

- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — the mirror image of the request-cap issue: local validation that does not match the
  upstream contract. Here the implementation *under*-bounded the payload the validator
  enforces; there the plan *over*-narrowed what the requirement permits. Both need a
  conformance test against the real contract.
- [`../workflow/before-agent-start-pending-state-injection.md`](../workflow/before-agent-start-pending-state-injection.md)
  — the single-handler `before_agent_start` contract and the module-level state reset that
  this feature reuses.
- [`../tooling/fallow-findings-for-inert-module-barrel.md`](../tooling/fallow-findings-for-inert-module-barrel.md)
  — expected `fallow` noise while a module is intentionally inert; re-check at wiring time.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-semantic-solution-ranking.md` (Findings
  M1 request-cap, M2 silent catch, M3 singleton reset; L4 unreachable guard, L7 untrusted
  content, L9 silent config fallback)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T19-06-37-144Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-05-jev-semantic-solution-ranking-requirements.md` (Goals, shadow contract, invariants, success criteria)
- **Plan:** `docs/plans/2026-10-05-jev-semantic-solution-ranking-plan.md` (Units 2–7; shadow-first + status mapping decisions)
- **Source files:** `extensions/ce-core/utils/solution-ranking.ts`,
  `extensions/ce-core/utils/solution-recall.ts`,
  `extensions/ce-core/utils/solution-wiring.ts`,
  `extensions/ce-core/commands/prompt-inject.ts`
- **Status:** feature ships shadow-first (inert). Findings M1/M2/M3 are deferred to a
  `04-5-debug` pass before `solutionRanking.shadow=false`; none block merge while inert.

## 🧠 Context Status

- **Health:** good — the learning is captured; the feature is inert and the deferred
  findings are time-boxed to the enforcement checkpoint.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md`,
  `extensions/ce-core/utils/solution-ranking.ts`,
  `extensions/ce-core/utils/solution-wiring.ts`,
  `docs/reviews/2026-10-05-jev-semantic-solution-ranking.md`
- **Recommendation for `06-docsync`:** record the shadow-first + deterministic-fallback
  decision as an ADR (if desired) and carry the M1/M2/M3 enforcement-checkpoint note plus
  the `CONTEXT.md` staging item into the docs sync. Re-publish the package so the updated
  `skills/*/references/solution-search*.md` reach a live session.
