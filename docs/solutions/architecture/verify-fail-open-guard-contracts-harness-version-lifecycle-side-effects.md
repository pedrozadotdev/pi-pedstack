---
title: Verify a Fail-Open Guard's Three Silent Contracts — Harness Version, Lifecycle Scope, Forbidden Side Effects
category: architecture
severity: high
tags:
  - pi-extension
  - jev
  - fail-open
  - shadow-first
  - harness-version
  - capability-detection
  - pinned-dependency
  - optional-event-field
  - silent-no-op
  - lifecycle-scope
  - per-session
  - per-episode
  - budget-reset
  - hook-contract
  - ui-side-effect
  - awaited-hook
applies_when:
  - A guard branches on a field of a harness/plugin event that may not exist in the declared minimum version
  - Reading an event defensively (`typeof x === "string" ? x : "unknown"`) and short-circuiting to a safe default on the unknown path
  - Shipping shadow-first / fail-open where a divergence looks identical to "guard ran and allowed"
  - A limit constant is named for one lifecycle scope but the state carrying it is reset at a different event
  - A documented contract says a hook must not perform some side effect (UI, disk, network) and the hook calls a helper that can
  - Typing an event as `unknown` and relying on a runtime reader instead of the harness type
---

# Problem

The context-health / semantic-compaction guard
(`extensions/ce-core/compaction-guard/`) is deliberately fail-open and shadow-first. That
policy is correct, but it made **three contract divergences invisible**, because in each
case the runtime behaviour degrades to exactly what stock behaviour already does — and no
test distinguishes "the guard ran and allowed" from "the guard never ran".

## 1. Harness version — the feature is a silent no-op on the pinned dependency

`firstBlockingGuard` requires the reason to be `threshold` before it will ever consider a
defer:

```typescript
// extensions/ce-core/compaction-guard/guard.ts:84-103
if (facts.reason !== "threshold") {
  return `not a threshold compaction (${facts.reason})`;
}
```

`reason` comes from the `session_before_compact` event, read defensively:

```typescript
// extensions/ce-core/index.ts:492-502
function mapCompactionEvent(event: unknown, ctx: ExtensionContext): CompactionGuardInput {
  const record = asRecord(event) ?? {};
  return { /* … */ reason: typeof record.reason === "string" ? record.reason : "unknown" };
}
```

`reason` / `willRetry` only exist on `SessionBeforeCompactEvent` in newer Pi harnesses. The
repo pins `@earendil-works/pi-coding-agent` devDependency `^0.76.0` (peer `>=0.74.0`), whose
type declaration has **neither field**; the fields appear in the harness `1.0.1` used to run
the extension. Under 0.76.0 every auto-compaction maps to `reason:"unknown"` → deterministic
`allow` → **Jev is never called and the defer feature does nothing**. Worse, the plan's
"Verified Pi API facts" cited `L579-L589` from the newer harness *as 0.76.0*, and nothing in
`README.md`/`AGENTS.md` states the required harness version. The fail-open path itself is
correct and pinned by a test, but that test asserts the *degradation*, not that the feature
is reachable on any supported version.

## 2. Lifecycle scope — a "per-session" cap is actually per-episode

```typescript
// extensions/ce-core/compaction-guard/facts.ts:20
/** Threshold checks are rare; bounds worst case at ~24s shadow / ~96s enforce. */
export const MAX_JEV_CALLS_PER_SESSION = 12;
```

```typescript
// extensions/ce-core/compaction-guard/store.ts:81-88
export function resetEpisode(sessionKey: string, now: Date = new Date()): void {
  const state = getOrCreateSessionState(sessionKey);
  // …
  state.jevCalls = 0;               // ← reset on every successful compaction
  state.lastCompactionAt = now.toISOString();
}
```

`resetEpisode` is called unconditionally from the `session_compact` handler. A session with
N compactions can therefore make up to `12·N` Jev calls, so the constant is
`MAX_JEV_CALLS_PER_EPISODE`. The name, the `facts.ts` comment justifying a session-wide
worst case, and the `CONTEXT.md`/`AGENTS.md` text all claim session scope.

## 3. Forbidden side effect — the hook reaches the UI despite a documented ban

The module contract (Unit 6 split, repeated in `AGENTS.md`) is that `turn_end` owns the
snapshot and the one-shot request nudge and **the hook never touches the UI**:

```typescript
// extensions/ce-core/index.ts:1599-1604 — session_before_compact handler
pi.on("session_before_compact", async (event, ctx) => {
  try {
    if (compactionMode === "off") return undefined;
    notifyInvalidCompactionModeOnce(ctx);          // → ctx.ui.notify(...) at index.ts:1016
    const result = await getCompactionGuard().evaluate(mapCompactionEvent(event, ctx));
    // …
```

`notifyInvalidCompactionModeOnce` calls `ctx.ui.notify` when the mode string is invalid.
In the normal flow `turn_end` has already set the one-time flag, so the hook is silent; but
a compaction occurring before any `turn_end` (or in print mode with a UI host) notifies from
the awaited hook. The existing test only exercises the `turn_end` path.

# Context

Captured as **M1 (lifecycle scope)**, **M2 (harness version)**, and **M3 (hook UI)** in
`docs/reviews/2026-10-06-context-health-and-semantic-compaction.md`, from the same loop as
[`./parity-test-extracted-security-helpers-against-the-original.md`](./parity-test-extracted-security-helpers-against-the-original.md).
The 03-work handoff had already recorded "the plan's 0.76.0 event citations were wrong" as
an invalidated assumption, but it was not converted into a version pin or a capability
probe before review.

The common root is structural, not incidental: **fail-open + shadow-first makes every
contract divergence observationally equivalent to healthy stock behaviour.** The declared
contracts the guard relies on — "`reason` is present", "the cap is per session", "the hook
never touches the UI" — are enforced by neither `tsc` (the event is typed `unknown`) nor
the test suite. A no-op, a mis-scoped budget, and a contract-breaking side effect all pass
green.

This complements
[`./shadow-mode-is-not-free-on-awaited-hooks.md`](./shadow-mode-is-not-free-on-awaited-hooks.md),
which covers the *cost* of an awaited advisory hook; this card covers its *correctness*:
what must be verified before "shadow-first" can be trusted to mean "runs but is inert"
rather than "never runs".

# Solution

## 1. Treat every harness field the feature branches on as a version-gated capability

- Pin and **document the minimum harness version** whose type declarations contain the
  field(s) the feature requires, in the same place the config is documented.
- Bump the devDependency used for typechecking to that version (or add a types shim) so
  `tsc` resolves the **real** event shape instead of an erased `unknown`.
- Add a **shape fixture per supported version** and assert the intended reachability:
  - a `0.76`-shaped event (no `reason`) must fail open **and** emit a one-time degraded
    notice so an operator can see the feature is inert, and
  - a `1.x`-shaped event must reach the Jev path.
  A test that only asserts the degraded path pins the failure mode, not the feature.

```typescript
// fail open, but make the no-op observable instead of silent
const reason = typeof record.reason === "string" ? record.reason : null;
if (reason === null) {
  logDegradedOnce("session_before_compact event has no `reason`; guard inert on this harness version");
  return deterministicAllow("unknown-reason");
}
```

Never turn shape drift into an error (requirement 6: fail open). The goal is to convert an
invisible no-op into a *logged, tested* state — not to block.

## 2. Name every limit for the lifecycle boundary at which it actually resets

- Decide the true scope first: which event clears the counter? `session_compact` clearing
  `jevCalls` makes it per-episode; only `session_start`/`session_shutdown` clearing it makes
  it per-session.
- Rename the constant to match (`MAX_JEV_CALLS_PER_EPISODE`), and re-derive the worst-case
  latency from that scope (`episodes_per_session × cap × timeout`), updating every doc that
  restates the budget.
- Alternatively, if session scope is the intent, stop resetting `jevCalls` in
  `resetEpisode` while still resetting `lastSignature`/`lastOutcome`/`consecutiveDefers`/
  `requestNotified`. Pick one; do not leave the name claiming the other.

## 3. Enforce documented hook side-effect bans at the hook entry point

- If a contract says "the hook never touches the UI", the hook must not call any helper that
  can. Move the notify out of the hook (leave it in `turn_end`), or gate it on a
  non-hook-only condition.
- Add a wiring test that fires `session_before_compact` at an invalid mode **before any
  `turn_end`** and asserts zero `ui.notify` calls. The adjacent happy-path test does not
  prove the ban.

# Why this works

- **Fail-open erases the evidence.** When the fallback equals stock behaviour, correctness
  bugs are invisible by construction. The remedy is to make the degraded path *observable*
  (a one-time notice/log) and to test the *reachable* path, not just the fallback.
- **A defensive reader is not a capability check.** `typeof x === "string" ? x : "unknown"`
  keeps the code from throwing, but it also converts "field absent because the harness is
  older" into "field absent because the event is malformed" — the same string. Version
  pinning plus per-version fixtures are what separate the two.
- **A constant's name is a contract the compiler cannot check for reset points.** The bug
  was not the value 12; it was that the reset site contradicted the name and the docs.
  Naming for the true scope makes the budget derivation correct.
- **A documented "never" is only real if a test exercises the entry point that could
  violate it.** The UI notify lived one call deeper than the tested path; at the hook entry
  point the contract is directly assertable.

# Prevention

- **On any event field not guaranteed by the declared minimum dependency version:** record
  the version requirement, add a per-version shape fixture, and log a one-time degraded
  notice on the unknown path. Do not ship a feature reachable only on a version nobody
  pinned.
- **Cross-check citation provenance in reviews:** a "verified API fact" must cite the
  version it was read from. Treat a plan that cites newer-harness line numbers as the
  pinned one as a P1.
- **For every cap/limit constant, grep its reset sites** and confirm the name matches the
  lifecycle boundary; re-derive documented worst-case numbers from that scope.
- **For every "the hook never…" contract line, find the test that asserts it at the hook
  entry point.** A test on a sibling path is not that test.
- **Prefer not to type-erase the harness event**; when you must, note in the reader why the
  type is unavailable and pin a fixture for the real shape.

## Downstream Impact

### For 02-plan

- "Verified API facts" must carry the source version; if the feature depends on a field only
  present in a newer harness, the plan must state the minimum version and a bump task.
- Any guard whose fallback equals stock behaviour must list, in the test diagram, the test
  that proves the **non-fallback** path is reachable on a supported version.

### For 04-review

- For a fail-open/shadow-first guard, ask: "what test proves the feature is not a no-op on
  the pinned dependency?" A missing answer is P1.
- Grep every limit constant name against its reset sites; a `PER_SESSION` name reset on
  `session_compact` is a correctness finding.
- For each documented hook contract ("never touches the UI/disk/network"), locate the
  entry-point test; if absent, require it.

## Related solutions

- [`./parity-test-extracted-security-helpers-against-the-original.md`](./parity-test-extracted-security-helpers-against-the-original.md)
  — sibling finding set from the same review (the sanitizer the guard calls).
- [`./shadow-mode-is-not-free-on-awaited-hooks.md`](./shadow-mode-is-not-free-on-awaited-hooks.md)
  — the *cost* of an awaited advisory hook; this card is its correctness counterpart.
- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — the same "declared contract ≠ implementation" failure mode at the plan level.
- [`./validate-model-authored-plan-fields-before-read-or-extract.md`](./validate-model-authored-plan-fields-before-read-or-extract.md)
  — source-driven verification of model-authored claims; a plan's "verified API facts" are
  such a claim.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-context-health-and-semantic-compaction.md`
  (M1, M2, M3).
- **Plan:** `docs/plans/2026-10-06-context-health-and-semantic-compaction-plan.md`
  ("Verified Pi API facts"; AD-2 "Frozen config/limits"; Unit 6 handler split).
- **Source files:** `extensions/ce-core/index.ts` (`mapCompactionEvent`,
  `notifyInvalidCompactionModeOnce`, `session_before_compact` handler at 1599-1612),
  `extensions/ce-core/compaction-guard/guard.ts` (`firstBlockingGuard`),
  `extensions/ce-core/compaction-guard/facts.ts` (`MAX_JEV_CALLS_PER_SESSION`),
  `extensions/ce-core/compaction-guard/store.ts` (`resetEpisode`), `package.json`.
- **Status:** documented; fixes are small (version pin + doc, rename/re-derive the cap,
  drop the hook notify) and deferred to `04-5-debug` / `03-work` because `04-review` is
  code-read-only.

## 🧠 Context Status

- **Health:** good — three isolated contract fixes, each pinned by a named test.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/index.ts`,
  `extensions/ce-core/compaction-guard/{guard,facts,store}.ts`,
  `extensions/ce-core/utils/redact.ts`, `package.json`
- **Recommendation for `06-docsync`:** record the minimum Pi harness version in `README.md`/
  `AGENTS.md`, correct the cap name/scope in `CONTEXT.md`, and carry M1/M2/M3 into the
  pre-merge checklist.
