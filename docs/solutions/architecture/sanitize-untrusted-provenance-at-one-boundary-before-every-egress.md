---
title: Sanitize Untrusted Provenance Once at the Boundary, Before Every Egress Consumer
category: architecture
severity: high
tags:
  - security
  - secret-exfiltration
  - sanitization
  - redaction
  - prompt-injection
  - untrusted-content
  - provenance
  - egress
  - single-boundary
  - fail-open
  - shadow-first
  - tool-result
  - pi-extension
applies_when:
  - A raw string derived from a tool invocation (command line, URL, file path) may contain credentials, tokens, or query secrets
  - That same string is serialized to more than one sink (external model request, on-disk log, or text prepended to the agent context)
  - Building a prompt-injection / untrusted-content screen, a telemetry record, or an enforce-mode wrapper
  - Reviewing a feature where only one of several consumers appears to redact a sensitive field
  - Deciding whether to fail open when a classifier degrades
---

# Problem

A screen for untrusted tool results classified each result's origin and derived a
`ref` (the raw `gh` command line, or the first URL in a `curl` command). That ref can
legitimately contain secrets — `GH_TOKEN=supersecret gh pr diff 1`,
`curl https://user:pass@host/path?token=...`. The same ref was then sent to **three
different egress points**, and only one of them sanitized it:

| Consumer | Location | Sanitized? |
| --- | --- | --- |
| External classifier request body | `buildInjectionRequest(provenance, …)` → `JevRequest.state.provenance.ref` | ❌ raw |
| On-disk telemetry record | `logStored()` → `sanitizeRef(stored.provenance.ref)` | ✅ |
| Agent-visible enforce wrapper | `wrapUntrusted()` header `(source: ${kind} ${ref})` | ❌ raw |

The result is a real secret-exfiltration path: the token/credential is shipped in the
process invocation for the external model (`cmd -p -m …` request body) and, in `enforce`
mode, embedded verbatim into the text prepended to the agent context. Only the low-risk
log was clean. The team's own tests (`refOf`) proved the *intent* to sanitize, which makes
the gap worse: intent was verified for one sink and assumed for the rest.

This is a general pattern, not a one-off. Whenever a value crosses a trust boundary, the
number of copies grows silently as consumers are added, and a per-sink fix guarantees the
next consumer is born unsanitized.

# Context

Surfaced while building the untrusted tool-result injection screen in `pi-pedstack`
(`extensions/ce-core/injection-screen/`), captured as finding **H1** in
`docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`.

The design had a good instinct — a single `sanitizeRef()` helper — but called it at the
wrong altitude, inside the log builder rather than where `provenance` enters the engine:

```typescript
// engine.ts — screen()
const request = buildInjectionRequest(provenance, sample.text); // raw ref
// ...
const stored: StoredVerdict = { verdict, provenance, mode, noul, confidence }; // raw ref

// engine.ts — logStored()
ref: sanitizeRef(stored.provenance.ref), // only this copy was sanitized

// wrapper.ts — wrapUntrusted()
`(source: ${provenance.kind} ${provenance.ref})`; // raw ref, and unbounded
```

Because the classify step (which extracts the raw command/URL) sits upstream of all three
consumers, the engine's `screen()` is the natural choke point. The sanitizer already
existed and was correct (credential assignment redaction, URL user/pass/query/fragment
stripping, whitespace collapse, length cap) — it was simply applied too late and too
narrowly. A related low-severity companion finding (**L1**) noted the wrapper interpolated
an unbounded, un-newline-escaped ref, so the "fixed" header could be inflated or made
multi-line; the same boundary fix resolves both.

Overlap check against `docs/solutions/`: the closest card is
`architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md`, whose section
"Bound *every* serialized field" is the byte-bounding analogue of this learning. That card
bounds fields for an **external payload-size contract**; this card redacts fields that
carry **secrets across a trust boundary**. The overlap is moderate (same shape: enumerate
every field that leaves the process), so this card is new and cross-linked rather than
folded into that one.

# Solution

## 1. Redact at the boundary where the value enters, not at each sink

Sanitize **once**, immediately after provenance classification, and store only the
sanitized value. Every downstream consumer then reads a value that is already safe,
whether or not it remembers to call the sanitizer:

```typescript
// engine.screen() — the single choke point
provenance = { ...provenance, ref: sanitizeRef(provenance.ref) };

const request = buildInjectionRequest(provenance, sample.text); // now sanitized
const stored: StoredVerdict = { verdict, provenance, mode, noul, confidence }; // sanitized
// logStored(), wrapUntrusted(), and any future consumer inherit the safe value.
```

Prefer replacing the field on the value that flows onward over calling the sanitizer at
each use site. A `sanitizeRef(stored.provenance.ref)` inside `logStored()` now becomes a
redundant belt-and-braces call, not the only defence.

## 2. Treat "fail open" as a rule about verdicts, never about redaction

The screen deliberately fails open: a classifier timeout yields `degraded`, a wrap miss is
dropped, and nothing ever blocks or rewrites agent content. That policy is correct — but it
must not leak into the sanitizer. Redaction is unconditional and cannot be skipped on the
degraded path, because the degraded path still egresses the ref to the log and (in
`enforce`) may still wrap. State the two rules separately:

- **Verdict policy:** unavailable/throwing classifier → `degraded`, never block.
- **Data policy:** every serialized/embedded field is bounded and sanitized on *all*
  paths, including `degraded`, `wrapMiss`, and `sweepTurn`.

## 3. Test the actual payloads, not the helper

A unit test on `sanitizeRef()` proves the helper works; it does not prove the request body
and the wrapper are clean. Assert on the **serialized consumers**:

```typescript
// the request that goes on the wire
expect(JSON.stringify(request)).not.toMatch(/GH_TOKEN=|user:pass|token=/);
// the text the agent sees in enforce mode
expect(wrapUntrusted(content, provenance)).not.toMatch(/GH_TOKEN=|user:pass/);
// both must respect the same bound
expect(provenance.ref.length).toBeLessThanOrEqual(200);
```

Add one assertion per egress point. When a new consumer is added, its test is the reminder
to route through the boundary value.

# Why this works

- **A trust boundary is a single place; sanitizing per sink is N places that drift.** The
  helper `sanitizeRef` was correct and tested, yet the feature still leaked because two of
  three call sites did not call it. Moving the call to the boundary converts "did every
  author remember?" into a structural property: the stored value is already safe.
- **Fail-open and sanitize-first are orthogonal.** Degradation is about how much you trust
  a verdict; redaction is about what you are willing to emit. Conflating them creates the
  tempting-but-wrong shortcut "we failed open, so pass the value through".
- **Serialized-payload assertions catch what helper assertions cannot.** The helper test
  gave false confidence precisely because it tested the function the log used and not the
  functions the wire and the wrapper used.
- **The unbounded-header bug (L1) shares the same root cause.** A single boundary fix gives
  length, whitespace, and credential handling in one place instead of three.

# Prevention

- **Enumerate every egress point in review.** For any field derived from a tool
  invocation, list each place it is serialized (network request, file, prompt text) and
  confirm a single upstream sanitize covers all of them. "We sanitize the log" is not
  evidence that the wire is clean.
- **Make the sanitized value the only one that exists downstream.** Redact before storing
  the domain object, not inside each consumer.
- **Add one assertion per serialized consumer** to the conformance tests, not just a helper
  unit test.
- **State the data rule next to the fail-open rule** so a degraded path cannot be read as a
  licence to pass raw values through.
- **Bound and normalize at the same boundary** — length cap plus whitespace collapse
  prevents the "fixed" wrapper header from being inflated or made multi-line.

## Downstream Impact

### For 02-plan

- When a unit introduces a raw provenance/reference string, freeze *where it is sanitized*
  as part of the plan's signatures, and list the egress points in the test diagram. Add a
  RED unit that asserts the wire and prompt-visible consumers are clean, not only a log.

### For 04-review

- Grep for the sanitizer name and for the raw field name; if a sanitized value is stored,
  flag any consumer that reads the raw field instead. Treat "only the log is sanitized" as a
  security blocker (P0), not a nit.
- Challenge any fail-open/`degraded` branch that forwards a raw sensitive field; the two
  policies are independent.

## Related solutions

- [`./shadow-first-semantic-ranking-with-deterministic-fallback.md`](./shadow-first-semantic-ranking-with-deterministic-fallback.md)
  — the byte-bound + one-entry-point analogue; that card bounds every field for an external
  size contract, this card sanitizes every field across a trust boundary.
- [`../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md)
  — another "classify once, act on the classified value" boundary; the fail-open/fail-closed
  split the screen reuses.
- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — the sibling "local validation not equal to the real contract" failure mode.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`
  (finding H1 high; companion L1 low).
- **Requirements:** `docs/brainstorms/2026-10-05-security-screen-untrusted-tool-results-requirements.md`
  ("Log schema and sanitization"; refs "never include credentials/tokens").
- **Source files:** `extensions/ce-core/injection-screen/engine.ts` (`screen`, `logStored`,
  `sanitizeRef`), `extensions/ce-core/injection-screen/decision.ts`,
  `extensions/ce-core/injection-screen/wrapper.ts`.
- **Status:** H1 is documented and not yet fixed — `04-review` forbids code edits and the
  capability matrix blocks `extensions/**`. Fix once at the `engine.screen()` boundary and
  carry the payload assertions into the merge.

## 🧠 Context Status

- **Health:** good — root cause captured, fix is a small boundary move plus payload tests.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/injection-screen/engine.ts`,
  `extensions/ce-core/injection-screen/wrapper.ts`,
  `extensions/ce-core/injection-screen/decision.ts`,
  `docs/reviews/2026-10-05-security-screen-untrusted-tool-results.md`
- **Recommendation for `06-docsync`:** record the boundary-sanitize rule in `CONTEXT.md`
  and carry the unfixed H1 into the pre-merge checklist; do not re-derive it.
