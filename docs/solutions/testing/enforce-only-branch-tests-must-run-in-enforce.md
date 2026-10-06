---
title: A Test for an Enforce-Only Branch Must Run in Enforce — Shadow-Mode Setup Makes the Assertion Vacuous
category: testing
severity: medium
tags:
  - pedstack
  - testing
  - shadow-mode
  - enforce-mode
  - mode-gating
  - vacuous-assertion
  - negative-assertion
  - falsifiable-test
  - test-harness
  - configuration-under-test
  - false-green
  - drift-guard
  - persisted-status
  - pi-extension
applies_when:
  - Writing a negative test ("writes nothing", "does not fire", "stays off", "no record") for a branch that is gated by a mode flag
  - A guard/feature behaves differently in `off | shadow | enforce` (or any mode/config enum)
  - The test harness factory has a default mode and the test overrides it
  - Reviewing a suite claimed to prove an enforce-only safety property
  - A green test is used as evidence for a plan unit whose requirement is mode-specific
---

# Problem

A negative test is only as strong as the configuration in which it runs. If the branch
under test is **mode-gated**, a test that constructs the harness in a mode where the
branch never executes proves nothing — the assertion is trivially true and the suite is
green while the requirement is unverified.

In the drift-correction suite (`tests/drift-guard.test.ts`), the plan requires
"call cap → **no** status write". The test named *"deterministic short-circuits write no
status"* built the capped harness in **shadow** mode:

```ts
// tests/drift-guard.test.ts
const capped = makeGuard({ mode: "shadow" });
for (let index = 0; index < MAX_DRIFT_JEV_CALLS_PER_SESSION; index++) {
  await capped.guard.evaluate(turn({ message: assistant([{ type: "text", text: `turn ${index}` }]), turnIndex: index }));
}
await capped.guard.evaluate(turn({ message: assistant([{ type: "text", text: "one more" }]) }));
expect(capped.statuses.size).toBe(0);
```

`writeStatus` is only ever called in `mode === "enforce"`. In `shadow`, **no** path writes
a status, so `capped.statuses.size` is `0` regardless of what the call-cap branch does.
The test asserts a property of shadow mode, not of the call-cap path. The enforce-mode
delta — "the cap path specifically does not write a status" — remains **unproven**, yet
the plan unit reads as covered.

The harness default is `mode: "enforce"` (`makeGuard()` with no override), so every other
status test in the file runs in the mode that can observe the behavior. Only the capped
harness silently opted out.

# Context

- The feature is a shadow-first advisory guard: `off` computes nothing, `shadow` computes
  and logs but writes no `DriftStatus`/`DriftRecord`, `enforce` may write both. The status
  writer is invoked only under `enforce`.
- The plan's fail-closed work (Unit 4 / Unit 5) makes claims about what is persisted in
  each mode. Those claims are only testable if the test runs in the relevant mode.
- The test was not wrong about the branch it set up — the per-session cap does short-circuit
  to a deterministic `no_drift` in shadow too. The defect is that the **status-write
  assertion** was attached to a shadow run, where it cannot discriminate.
- This is the test-side counterpart of
  [`../architecture/shadow-mode-is-not-free-on-awaited-hooks.md`](../architecture/shadow-mode-is-not-free-on-awaited-hooks.md):
  that card says shadow still runs; this card says shadow must not be the mode used to
  *verify an enforce-only write*.

# Solution

## 1. Build the harness in the mode that enables the branch

```ts
// before — shadow never writes a status, so the assertion cannot fail
const capped = makeGuard({ mode: "shadow" });
...
expect(capped.statuses.size).toBe(0);

// after — enforce is the only mode that can write, so the delta is observable
const capped = makeGuard(); // enforce by default
for (let index = 0; index < MAX_DRIFT_JEV_CALLS_PER_SESSION; index++) {
  await capped.guard.evaluate(turn({ message: assistant([{ type: "text", text: `turn ${index}` }]), turnIndex: index }));
}
const before = capped.statuses.size;
await capped.guard.evaluate(turn({ message: assistant([{ type: "text", text: "one more" }]) }));
expect(capped.statuses.size).toBe(before); // the cap did not ADD a status
```

Asserting `size` stays unchanged (rather than `=== 0`) is the sharper form: it proves the
capped evaluate did not write, while allowing the earlier capped turns to have written —
which is exactly the enforce-mode behavior under test.

## 2. Make the positive behavior observable in the same mode

A negative assertion is meaningful only if the opposite outcome is reachable. Confirm that
in the chosen mode, the code path *could* have written the record/status. If it could not,
the test is a tautology.

```ts
// sanity anchor: the same harness in enforce DOES write on a non-capped turn
harness.setValues({ in_stage_scope: 0.1 });
await harness.guard.evaluate(turn());
expect(harness.statuses.size).toBe(1); // proves the writer is wired and observable
```

## 3. Name the mode in the test and cover each mode once

Split mode-specific claims into per-mode tests (`shadow writes neither a status nor a
record`; `enforce writes a status for a degraded outcome`). One test per mode makes the
configuration explicit and prevents a later edit from silently switching the mode.

```ts
test("enforce call cap writes no additional status", async () => { /* enforce */ });
test("shadow writes neither a status nor a record", async () => { /* shadow */ });
```

# Why this works

- **Mode gating makes branches unreachable, not false.** `statuses.size === 0` in shadow is
  true by construction; no amount of running will disprove or prove the cap property.
- **A negative assertion needs a reachable positive.** If no code path in the chosen mode
  can produce the thing being asserted absent, the assertion carries zero information.
- **The default mode is a hidden variable.** A harness factory with an enforce default means
  the one test that overrides to shadow is the one test that stops testing enforce behavior
  — and it still reads as coverage.
- **"Delta" is the correct assertion for a cap.** `size === 0` conflates "cap wrote nothing"
  with "nothing ever writes here"; `size` unchanged across the capped call isolates the
  branch.

# Prevention

- **For every "writes nothing / does not fire / stays off" test, state the mode in the test
  name and assert it in the harness.** If the branch is mode-gated, the harness must be in
  that mode.
- **Add a positive anchor in the same mode** proving the recorder is wired; without it a
  negative test can pass because the feature is entirely absent.
- **Review checklist for plan units claiming a mode-specific property:** open the test,
  read the `makeGuard({ mode })` argument, and confirm it equals the mode the unit names.
- **Prefer delta assertions for caps/dedupe/TTL.** Assert the second call does not *add*
  state, not that total state is zero.
- **Treat an explicit `mode: "shadow"` override inside a suite whose default is `enforce`
  as a review flag** unless the test is specifically about shadow behavior.

# Downstream Impact

### For `02-plan`

- When a unit claims a mode-specific property, name the mode in the test scenario, not just
  the behavior.
- State the positive anchor for each negative test (what proves the writer is reachable).

### For `04-review`

- For each negative/mode-gated test, verify the harness mode and that the asserted-absent
  state is reachable in that mode.
- Flag a `mode` override that does not match the requirement the test is cited for.

## Related solutions

- [`../architecture/shadow-mode-is-not-free-on-awaited-hooks.md`](../architecture/shadow-mode-is-not-free-on-awaited-hooks.md)
  — the runtime counterpart: shadow still executes on awaited hooks; this card covers using
  shadow to verify an enforce-only write.
- [`../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`](../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md)
  — shadow/enforce rollout semantics and why shadow is not a safety net.
- [`./child-process-event-listener-mock-for-pi-extension-tests.md`](./child-process-event-listener-mock-for-pi-extension-tests.md)
  — the other half of pi-extension test-harness setup (mocking the child process).

## Provenance

- **Issue:** [#8 — Detect turn-level stage drift and inject correction](https://github.com/pedrozadotdev/pi-pedstack/issues/8)
- **Source review:** `docs/reviews/2026-10-06-turn-level-stage-drift-corrections.md`
  (Finding L — shadow-mode cap test)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T18-01-27-036Z-04-review-to-05-learn.md`
- **Plan:** `docs/plans/2026-10-06-turn-level-stage-drift-corrections-plan.md` (Unit 4,
  "call cap → no status write")
- **Source files:**
  - `tests/drift-guard.test.ts:464-492` — capped harness built with `mode: "shadow"`
  - `tests/drift-guard.test.ts:81-130` — `makeGuard` default `mode: "enforce"`
- **Status:** test-only fix (run the capped harness in `enforce`, assert the delta) is
  autofixable and was withheld because `04-review` must not modify the tree. No source or
  test was modified in `05-learn`.

## 🧠 Context Status

- **Health:** good — learning captured from the 04-review findings; no source was modified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/testing/enforce-only-branch-tests-must-run-in-enforce.md`,
  `tests/drift-guard.test.ts`,
  `docs/plans/2026-10-06-turn-level-stage-drift-corrections-plan.md`
- **Recommendation for `06-docsync`:** link this card from the drift feature test docs; the
  autofixable cap-test fix and the `04-review`'s other deferred low findings
  (`degradedDriftBlocker` wording, `strongDriftBlocker` hardcoded "2 turns", stray
  `package-lock.json`, dangling `docs/reviews` link) should be carried into the fix-forward
  work and closed during `06-docsync` or a follow-up `03-work`.
