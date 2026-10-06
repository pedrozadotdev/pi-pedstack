---
title: Keep Degraded-Mode Fallbacks Out of Primary-Signal State
category: architecture
severity: medium
tags:
  - pi-extension
  - failure-triage
  - jev
  - fallback
  - degraded-mode
  - signal-semantics
  - escalation-signal
  - source-provenance
  - state-machine
  - fail-open
  - advisory
  - sentinel-value
  - threshold-counter
applies_when:
  - A primary judgment (remote model / expensive runtime) has a deterministic fallback for outage or abstention
  - A counter, streak, or escalation signal is derived from the primary judgment's quality/clarity
  - The degraded fallback must write a value for the same field as the primary path (e.g. clarity 0)
  - Adding or reviewing any `source`-tagged record that feeds a streak or threshold
---

# Problem

The failure-triage escalation signal was defined to mean *"the worker model is repeatedly unable to localize the failure"* — model flailing, the condition #6/#7 would later use to escalate. But three consecutive **Jev outages** (timeouts), which are triage-**infrastructure** failures with no model judgment at all, raised the same signal:

```text
Jev timeout → heuristic fallback, rootCauseClarity = 0
3 × (clarity < 3) → lowClarityStreak = 3 → escalationSignal: true
```

A consumer could not distinguish "the worker is stuck three times" from "our triage runtime was down three times."

# Context

This showed up while wiring the first real consumer of the Jev runtime (`extensions/ce-core/jev/`) into a `tool_result` feature that annotates failed verification commands (issue #12). The flow is:

1. `shouldTriage` gate passes for a failing verification command in `03-work` / `04-5-debug`.
2. `decideOrHeuristic` calls `runtime.decide(...)` with a 2.5 s cap.
3. On **any** failure/timeout/invalid answer it calls `heuristicClassify(excerpt)`.
4. The heuristic has no model, so it always writes `rootCauseClarity: 0` and `source: "heuristic"`.
5. `updateStreak` incremented `lowClarityStreak` for anything `clarity < 3` — including step 4.

The two paths already carried a discriminator (`source: "jev" | "heuristic" | "skipped"`), but the streak computation ignored it and used the *value* instead. Because a genuine Jev answer can also be `rootCauseClarity: 0`, the value alone can never separate the two cases — only provenance can.

This was found by the `04-review` correctness pass (finding M3) after `bun test` was already green: every test used a *successful* or *failing* runtime, but no test asserted that a fallback must not move the signal.

# Solution

Advance the streak only for the primary source; let a fallback pass the current state through unchanged.

```ts
// extensions/ce-core/tools/failure-triage-runner.ts
function updateStreak(
  source: TriageRecord["source"],
  clarity: number,
): { streak: number; signal: boolean } {
  // ponytail: only a Jev clarity judgment counts toward the streak; a heuristic
  // fallback (clarity 0) during a Jev outage is not worker-model flailing.
  if (source === "jev") {
    lowClarityStreak = clarity >= 3 ? 0 : lowClarityStreak + 1
  }
  return { streak: lowClarityStreak, signal: lowClarityStreak >= 3 }
}
```

And verify the invariant with a fallback-only negative test:

```ts
test("does not count heuristic fallbacks toward the escalation signal", async () => {
  const runtime = createFakeJevRuntime({ handler: () => new Error("timeout") })

  await runFailureTriage(baseInput(), makeDeps(runtime))
  await runFailureTriage(baseInput(), makeDeps(runtime))
  await runFailureTriage(baseInput(), makeDeps(runtime))

  expect(getLowClarityStreak()).toBe(0)
  const latest = await readLatestTriage(repoRoot)
  expect(latest?.source).toBe("heuristic")
  expect(latest?.escalationSignal).toBe(false)
})
```

`updateStreak` takes `source`, not just the value — the signature is the fix. A caller cannot silently feed fallback output into the streak again because it would have to fabricate `source: "jev"`.

# Why this works

- **A sentinel is not an observation.** The heuristic's constant `0` means "no judgment available", not "the failure is opaque". Writing the same number the primary path uses for a real low-clarity result erases that distinction at the only place it mattered.
- **Provenance is the only reliable discriminator.** You cannot recover "was this observed or defaulted?" from the value, because the primary path may legitimately produce that exact value. Carry the discriminator explicitly.
- **One signal must trace to one evidence source.** An escalation signal that mixes model quality with infrastructure health cannot answer either question, and every downstream consumer inherits the ambiguity.
- **The signature is the enforcement.** Making `updateStreak(source, clarity)` — rather than `updateStreak(clarity)` — turns the rule into a caller obligation instead of a comment.

# Prevention

- Whenever a degraded path must write a value into a field shared with the primary path, record `source`/`provenance` alongside it and branch counters, streaks, and thresholds on the source, never on the value.
- Add a negative test with **N consecutive fallbacks** asserting the derived signal stays in its "no data" state. The existing tests all drove a successful or Jev-answered runtime, so the bug survived a green suite.
- Decide per-source reset semantics explicitly: the fix leaves the streak unchanged on fallback (neither increments nor resets), because an outage is neither evidence nor a success. State that intent in the code or test, not only in the review thread.
- In `04-review`, treat "constant sentinel value produced by a degraded path that participates in a counter/threshold" as a review finding, even when the module is advisory.

# Downstream Impact

### For `02-plan`

- When a plan defines a fallback for an unavailable primary judgment, require the fallback's `source` tag and specify whether fallbacks may mutate any derived counter/signal. An unspecified fallback is a future false signal.
- Add the fallback-only sequence (N× outage → signal unchanged) to the test diagram next to the happy-path streak test. Testing only the primary path is the exact blind spot that shipped here.

### For `04-review`

- Open the file that computes the signal and ask: *can the degraded path reach this line, and does the value it writes pass the same threshold as a real observation?*
- Check that every field feeding a threshold is either (a) annotated with provenance or (b) provably unreachable from the fallback. "Tests are green" is not evidence for either.

# Related learnings

- [`../workflow/auto-advance-workflow-via-tool-result-interception-with-authorization-gates.md`](../workflow/auto-advance-workflow-via-tool-result-interception-with-authorization-gates.md) — the `tool_result` handler, pure-verdict + thin-effectful-handler, and fail-open patterns that this feature reuses; the failure triage handler is the 4th such handler.
- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md) — the sibling divergence class found in the same review (M1/M2/M5: unreachable `source: "skipped"`, `escalationSignal` boolean vs versioned object, truncated `details.triage`).

# Provenance

- **Issue:** [#12 — Jev: triage failed tests/builds before deep debugging](https://github.com/pedrozadotdev/pi-pedstack/issues/12)
- **Source review:** `docs/reviews/2026-02-14-jev-failure-triage.md` (Finding M3, autofix applied)
- **Source plan:** `docs/plans/2026-02-14-jev-failure-triage-plan.md` (Unit 4, streak semantics)
- **Requirements:** `docs/brainstorms/2026-02-14-jev-failure-triage-requirements.md` (escalation-signal section)
- **Source files:**
  - `extensions/ce-core/tools/failure-triage-runner.ts` — `updateStreak(source, clarity)`, `decideOrHeuristic`
  - `extensions/ce-core/tools/failure-triage.ts` — `TriageSource = "jev" | "heuristic" | "skipped"`
  - `extensions/ce-core/tools/triage-store.ts` — `PersistedTriage.source` / `escalationSignal`
  - `tests/failure-triage-runner.test.ts:277` — `does not count heuristic fallbacks toward the escalation signal`
- **Verification:** `bun test` → 624 pass / 1 skip / 0 fail; `bunx tsc --noEmit` clean; `fallow_audit` base=HEAD pass
- **Branch:** `agent-pedroza-dot-dev/jev-triage-failed-tests-builds-before-deep-debug`

## 🧠 Context Status

- **Health:** good — the M3 fix is applied, tested, and verified; M1/M2/M4/M5/L* remain recorded as open decisions in the review and do not block this learning.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/tools/failure-triage-runner.ts`, `extensions/ce-core/tools/failure-triage.ts`, `tests/failure-triage-runner.test.ts`
- **Recommendation for `06-docsync`:** link this card from the failure-triage feature docs and from the #6/#7 escalation-signal design notes so the provenance rule is visible before a consumer reads the boolean `escalationSignal`.
