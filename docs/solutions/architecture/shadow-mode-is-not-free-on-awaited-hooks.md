---
title: Shadow Mode Is Not Free on Awaited Hooks — Bound Advisory Latency and Keep Fail-Closed Off Cold Start
category: architecture
severity: high
tags:
  - pi-extension
  - jev
  - shadow-mode
  - advisory-guard
  - awaited-hook
  - turn-end
  - latency-budget
  - critical-path
  - fail-closed
  - availability
  - cold-start
  - verdict-attribution
  - drift-guard
  - deterministic-pre-pass
  - fire-and-forget
  - timeout
applies_when:
  - Placing a model/semantic call (Jev, LLM, network) inside a hook pi awaits (turn_end, before_agent_start, tool_call, tool_result)
  - Shipping a "shadow-first" advisory layer and describing it as inert / no-op
  - Opting into fail-closed on a signal that may legitimately have no data yet (cold start, TTL expiry, wrong session)
  - Reusing or keeping a prior verdict instead of recomputing it (dedupe, unchanged-signature reuse, escalation hold)
  - Writing an advisory verdict to a persisted record that operators read to explain a block
---

# Problem

"Shadow mode" is usually defined as **does not change outcomes** — compute, log, do not
enforce. That is not the same as **does not run**. When the shadow layer is invoked from a
hook that pi **awaits**, every shadow turn still pays the live model call's latency, and a
fail-closed flag on the same signal can block work that has no signal at all.

Three distinct defects share this root cause and all three are easy to miss because the
feature is "supposed to be inert":

1. **Inert but awaited.** The default mode still spawns the external model and blocks the
   awaited hook, because the shortcut only skips `mode === "off"`, not `mode === "shadow"`.
2. **Fail-closed with no data.** A fail-closed gate treats "no record yet" the same as
   "record is degraded", so the first cross-stage save of a session (or after a TTL gap)
   is blocked even though the advisory layer never observed anything.
3. **Attribution erased by reuse/hold.** A kept verdict that is re-persisted with an empty
   trigger list silently loses *why* it was raised, so the block message degrades to
   "unspecified" and the shadow log loses the dimension that mattered.

# Context

Surfaced building turn-level stage-drift detection in `pi-pedstack`
(`extensions/ce-core/drift/{types,combine,turn-state,store,guard,index}.ts`, wired into
`extensions/ce-core/tools/context-handoff.ts` and the single `turn_end` handler in
`extensions/ce-core/index.ts`). The design is a textbook shadow-first advisory layer: a
bounded Jev `noul` question set judges each distinct non-trivial turn, derives
`clear | mild | strong_drift`, logs to `.context/compound-engineering/drift.jsonl`, and
only `mode === "enforce" && source === "jev"` may write or clear a `DriftRecord`.

The review (`docs/reviews/2026-10-06-turn-level-stage-drift-detection.md`) confirmed the
verdict truth table, the single freshness predicate, the write-source rule, and the save
ordering all hold — and then found the three issues above:

- **HS-1:** `resolveDriftMode` returns `"shadow"` for a missing/invalid
  `PEDSTACK_DRIFT_GUARD`; `evaluateDrift` only short-circuits on `"off"`, so shadow reaches
  `runJevJudgment → deps.createJev().decide(..., { timeoutMs: 8000 })`, which shells out to
  a child process. pi `await`s each `turn_end` handler in the agent loop, so up to 24
  distinct turns per session (the per-session cap) can each wait up to 8 s *even though
  shadow cannot block or inject*.
- **MS-3:** `runDriftCompletion` blocks when `drift.failClosed && !fresh`, and `!fresh`
  conflates *no record ever written*, *expired*, *wrong session*, *degraded source*,
  *only trivial turns*, and *cap reached*. The blocker text attributes all of them to a
  "degraded" layer, which is wrong for the no-data case.
- **MS-4:** `deriveVerdict`'s no-soft branch keeps `strong_drift` but returns
  `triggered: []`; `persistOutcome` then overwrites the prior record's dimensions, so
  `strongDriftBlocker` falls back to `"unspecified"`.

The plan's "not weaker than today" clause held for **verdict strength/fail-open** but did
not disclose the default-on live call or its latency — the clause was read as covering
latency too. It does not.

# Solution

## 1. Separate the "run" axis from the "enforce" axis

Shadow-first needs **two** independent switches, not one:

```text
mode:    off | shadow | enforce     # off  = do not run at all
live:    on  | off (opt-in)         # shadow may compute; must it be awaited/live?
```

- `mode === "off"` must be a true no-op: no Jev call, no spawn, no await.
- `mode === "shadow"` must not sit on an awaited path unless `live` is explicitly enabled.
  Concretely, pick one: fire-and-forget the `decide()` (do not `await` it), give shadow a
  much shorter timeout than enforce (e.g. 1–2 s vs 8 s), or require
  `PEDSTACK_DRIFT_GUARD_LIVE=1` before shadow makes a live call.
- Publish the choice. If the default configuration makes a live call, say so in the plan's
  "not weaker than today" section and in `README.md`/`CONTEXT.md`, with the timeout and the
  per-session cap.

## 2. Fail-closed must mean "expected data is missing", never "no data yet"

Before blocking on `failClosed`, distinguish:

```text
no record ever / wrong session / only-trivial / cap-reached  → NOT expected yet → fail open
record exists but source is degraded/expired (freshness)     → expected but unusable → fail closed
```

A cold start is not a degraded layer. Either block only when a fresh record was
*expected* and absent, or require one successful Jev turn before the gate can enforce.
Keep the blocker wording aligned with the actual state — do not label a cold start
"semantic layer degraded".

## 3. Preserve verdict attribution across reuse and hold

Any path that re-persists or reuses a verdict without recomputing it must carry the
original `triggered`/dimensions forward:

- A kept `strong_drift` (no-soft turn, not yet clear) keeps the prior record's `triggered`.
- A dedupe-reused outcome is a distinct `source: "deterministic"` and does not silently
  drop the attribution the original `jev` turn produced.
- When collapsing a reason to a single field, never overwrite a populated list with `[]`.

## 4. One sanitizer, one freshness predicate (reuse the existing cards)

The drift egress sanitizer (`redactSecrets`) and the freshness check (`isDriftRecordFresh`)
were second implementations of logic that already exists in the injection screen and the
handoff-readiness store. Extract the shared helper and keep exactly one freshness predicate
per record type; see the related cards below rather than re-deriving them here.

# Why this works

- **The hook contract decides the cost, not the mode.** pi `await`s every registered
  handler in order, so *any* awaited work is user-visible latency regardless of whether the
  verdict is later consumed. "Inert" describes the effect on outcomes; it says nothing
  about time. Naming that distinction is what turns HS-1 from "works as designed" into a
  disclosed, bounded default.
- **Fail-open/fail-closed is a policy about expected data.** Fail-closed is only defensible
  when the gate can distinguish "the producer ran and failed" from "the producer has not
  run". Conflating them converts a safety flag into an availability trap at exactly the
  moment (cold start) a user is least able to diagnose it.
- **A block message is only as good as its attribution.** Preserving `triggered` across
  reuse keeps the operator-facing explanation and the shadow log truthful; erasing it makes
  both the block and the calibration data unactionable.

# Prevention

- **When adding any Jev/LLM/network call, ask first: "is this handler awaited?"** Write the
  answer and a latency budget (timeout + per-session cap) into the plan before coding.
- **Model shadow as two flags** (`run` vs `enforce`) and test that `off` performs no call
  and that shadow does not `await` a live call unless explicitly enabled.
- **Never gate fail-closed on a signal with a legitimate empty state** without a separate
  "expected yet" predicate; test the cold-start path explicitly.
- **When a verdict is reused or held, assert the attribution survives** — add a test for
  the intermediate "still strong, no new soft signal" record's `triggered`.
- **Keep one sanitizer and one freshness predicate per record type**; a second copy diverges
  silently on the next hardening pass.

# Downstream Impact

### For 02-plan

- For any semantic layer in a hook, freeze **both** switches (`mode`, `live`) and a latency
  budget in the plan; state whether the *default* configuration makes a live call.
- Add an explicit cold-start case to the fail-closed design and name what "expected yet"
  means for the signal.
- Require a test that a reused or held verdict retains its `triggered` dimensions.

### For 04-review

- Grep the handler wiring: does `mode === "shadow"` actually skip the live call, or only
  `mode === "off"`? If pi awaits the handler, flag the default-on latency.
- Challenge every `failClosed && !fresh` (or equivalent) predicate: enumerate the states
  `!fresh` covers and confirm none is a legitimate no-data state.
- Confirm a kept/reused verdict cannot overwrite a populated trigger list with `[]`.
- Flag a second egress sanitizer or freshness predicate as a single-source-of-truth defect.

## Related solutions

- [`./shadow-first-semantic-ranking-with-deterministic-fallback.md`](./shadow-first-semantic-ranking-with-deterministic-fallback.md)
  — the shadow-first + never-weaker-fallback contract this feature reuses. That card is
  about *outcome* safety (`enforced = !shadow`, degraded never weaker); this card is the
  missing *time/resource* axis (an awaited shadow call still costs latency).
- [`../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`](../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md)
  — shadow/enforce rollout and fail-open vs fail-closed for a completion gate; complements
  the cold-start fail-closed finding here.
- [`./keep-degraded-fallbacks-out-of-primary-signal-state.md`](./keep-degraded-fallbacks-out-of-primary-signal-state.md)
  — why a degraded fallback must not masquerade as a primary signal; related to the MS-3
  wording and the MS-4 attribution loss.
- [`./one-freshness-predicate-reused-at-every-read-site.md`](./one-freshness-predicate-reused-at-every-read-site.md)
  and [`./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`](./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md)
  — the reuse rules the drift guard should have followed for freshness and redaction.
- [`../workflow/deterministic-first-semantic-guard-for-indirect-bash-tool-actions.md`](../workflow/deterministic-first-semantic-guard-for-indirect-bash-tool-actions.md)
  — deterministic-first ordering to keep the semantic call off the common path.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-turn-level-stage-drift-detection.md`
  (HS-1 awaited shadow latency; MS-3 fail-closed cold-start trap; MS-4 kept-strong loses
  `triggered`; MS-1 duplicate sanitizer)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T14-24-32-862Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-06-turn-level-stage-drift-detection-requirements.md`
- **Plan:** `docs/plans/2026-10-06-turn-level-stage-drift-detection.md` (AD-2/AD-5/AD-6;
  the "not weaker than today" clause)
- **Source files:** `extensions/ce-core/drift/{guard,combine,store,index}.ts`,
  `extensions/ce-core/tools/context-handoff.ts`, `extensions/ce-core/index.ts`
- **Status:** drift feature ships shadow-first (inert on outcomes) but the default still
  makes a live awaited call — deferred to a `04-5-debug` pass; no code changed in `05-learn`.

## 🧠 Context Status

- **Health:** good — learning captured from the 04-review findings; no source was modified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/architecture/shadow-mode-is-not-free-on-awaited-hooks.md`,
  `extensions/ce-core/drift/guard.ts`, `extensions/ce-core/drift/combine.ts`,
  `extensions/ce-core/tools/context-handoff.ts`,
  `docs/reviews/2026-10-06-turn-level-stage-drift-detection.md`
- **Recommendation for `06-docsync`:** carry the HS-1/MS-3/MS-4 fix-forward note into the
  docs sync; if the default live-call latency is accepted, record that decision (ADR) and
  update `README.md`/`CONTEXT.md` to disclose the default-on call, its timeout, and the
  per-session cap.
