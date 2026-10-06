---
title: Extracting a Security Helper Is a Coverage Change — Parity-Test It Against the Original
category: architecture
severity: high
tags:
  - security
  - redaction
  - secret-exfiltration
  - refactor
  - extraction
  - regex
  - redos
  - regression
  - parity-test
  - single-boundary
  - pi-extension
  - jev-egress
applies_when:
  - A security-sensitive function (redactor, sanitizer, validator, escaper) is moved into a shared helper or reused by a new consumer
  - Hardening a regex for a different concern (ReDoS/backtracking, anchoring, unicode) at the same time as the extraction
  - A credential/token pattern is bounded with a quantifier and/or anchored with `\b` / `^` / `$`
  - Promoting a previously single-consumer sanitizer to "the one sanitizer" for a wider egress surface
  - Reviewing a diff whose only test for a redactor uses a short, well-formed input
---

# Problem

`extensions/ce-core/utils/redact.ts` was introduced as the **single shared
conversation-excerpt sanitizer** for both the drift guard and the new compaction guard
(design decision AD-7). Extracting it merged two concerns into one regex change:

1. **The intended fix:** bounding the keyword prefix with `{0,64}` so a long excerpt with
   no `=` cannot trigger catastrophic backtracking (the earlier unbounded `*` stalled for
   >1 min on a 2M-char run; the bounded form runs in ~758 ms).
2. **An unintended narrowing:** adding a leading `\b` word-boundary anchor.

```typescript
// extensions/ce-core/utils/redact.ts:7-8
const CREDENTIAL_ASSIGNMENT =
  /(\b[A-Za-z0-9_]{0,64}(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi;
```

The pre-extraction drift regex was:

```typescript
/([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi
```

`\b` asserts a word boundary at the **start of the prefix run**. When a cookie, base64
blob, or identifier immediately precedes the keyword with only word characters between
them, there is no boundary there, so the match never starts:

```text
input:  "prefix_" + "A".repeat(80) + "SECRET=leakme"
old:    …AAAASECRET=[redacted]     ✅ redacted
new:    …AAAASECRET=leakme         ❌ unchanged → egresses to the external Jev process
```

This is a real secret-leak path, not a cosmetic miss: the excerpt is serialized into the
Jev request body. It is a regression **created by the extraction**, and the only test for
the helper (`tests/compaction-guard-combine.test.ts`) exercises a short, clean key
(`API_TOKEN=abc123`), which both implementations pass.

A companion finding (**L3**) is the same class of extraction risk: `redactSecrets`
scrubs only the **first** URL.

```typescript
// extensions/ce-core/utils/redact.ts:9-23
const FIRST_URL = /https?:\/\/[^\s]+/;
const url = FIRST_URL.exec(out)?.[0];
if (url) out = out.replace(url, parsed.toString()); // replaces one occurrence only
```

The single-URL limitation was pre-existing in `drift/combine.ts`, but AD-7 promoted this
function to the sanitizer for the compaction egress too, so the gap now covers a wider
surface. `"https://a.test/x?token=1 https://b.test/y?token=2"` leaves `b.test`'s query
intact.

# Context

Captured as **H1 (high)** and **L3 (low)** in
`docs/reviews/2026-10-06-context-health-and-semantic-compaction.md`, from the
context-health / semantic-compaction guard loop. The review is explicit that the bounded
`{0,64}` is load-bearing and the `\b` is not: dropping the anchor restores coverage and
remains linear (2M-char run 758 ms).

This is the same trust boundary as
[`./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`](./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md),
which established *where* to sanitize. This card is the corollary for *how the sanitizer
itself changes* when it is extracted and given a second consumer: a boundary refactor is a
behavioural change and must be proven not to redact less.

The test-coverage blind spot is the generalisable part. A helper unit test with a
well-formed input proves the helper works on the happy path; it cannot prove the helper
still redacts everything the old implementation did on adversarial inputs. The extraction
shipped with the test that was easiest to write, not the test that would have caught the
regression.

# Solution

## 1. Treat "redact at least as much as before" as a testable lower bound

Keep the pre-extraction implementation (in the test) and assert the new one is a superset
over adversarial inputs. Redaction is monotone under refactor: the new helper may redact
*more*, never less.

```typescript
const OLD = /([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi;
const cases = [
  "API_TOKEN=abc123",
  "prefix_" + "A".repeat(80) + "SECRET=leakme", // >64-word-char prefix
  "no equals here ".repeat(50),                 // ReDoS probe, no `=`
  "GH_TOKEN=1\nOTHER_KEY=2",                    // multiple assignments
  "https://a.test/x?token=1 https://b.test/y?token=2", // multiple URLs
];
for (const input of cases) {
  expect(redactSecrets(input)).not.toMatch(/leakme|token=1|token=2/);
}
```

Add a case for every *reason* the regex carries an anchor, a bound, or a flag, and keep
the old regex next to it as the oracle.

## 2. Separate the hardening concern from the coverage concern in the diff

The ReDoS fix is the bounded `{0,64}`; the `\b` belongs to nothing. Do not bundle an
anchor with a quantifier in the same edit without a test that pins the coverage the anchor
removes.

```typescript
// bounded prefix, no start anchor — linear and maximal coverage
const CREDENTIAL_ASSIGNMENT =
  /([A-Za-z0-9_]{0,64}(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi;
```

## 3. A sanitizer must iterate every match, never the first

When a helper is promoted to "the one sanitizer" for a whole excerpt, `exec`/`replace`
with a string is a leak by construction — only one occurrence is scrubbed.

```typescript
for (const match of out.matchAll(/https?:\/\/[^\s]+/g)) {
  const url = match[0];
  try {
    const parsed = new URL(url);
    parsed.search = ""; parsed.hash = "";
    parsed.username = ""; parsed.password = "";
    out = out.replace(url, parsed.toString());
  } catch { /* not parseable; credential redaction already applied */ }
}
```

## 4. Assert on the egress payload, per the boundary card

Helper-level assertions are necessary, not sufficient. Add the
`JSON.stringify(request)` / wrapped-text assertions from
[`./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`](./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md)
so a future regression is caught where it matters — at the process/wire boundary, not just
inside the helper.

# Why this works

- **An extraction is a second implementation, and only a differential test compares them.**
  The helper and the original were "the same algorithm", but the anchor made them differ
  on exactly the inputs the original test did not use. A parity test encodes "never
  redact less" instead of trusting the diff to be behaviour-preserving.
- **`\b` and `{0,64}` are orthogonal.** One bounds backtracking (a performance property);
  the other restricts where a match may begin (a coverage property). Bundling them made a
  performance fix silently weaken a security control.
- **A single-occurrence sanitizer does not scale with the value it is applied to.** The
  function's contract changed from "scrub the one ref" to "scrub a whole excerpt"; only
  `matchAll` honours the new contract.
- **Fail-open does not apply to redaction.** If the helper under-redacts, no degraded
  verdict or confidence check rescues the leaked value — it is already gone.

# Prevention

- **When extracting a security-sensitive helper, copy the old body into the test as an
  oracle** and add adversarial cases (long prefixes, multiple matches, no delimiter,
  newlines, unicode). Assert the new output never contains a secret the old output
  redacted.
- **Split the diff by concern:** a ReDoS/performance fix in one change, an anchor/coverage
  change in another, each with its own test. Never let a hardening edit quietly narrow
  matches.
- **Promote-to-shared is a scope expansion.** When a helper gains a second egress
  consumer, re-derive its contract for the wider input (whole excerpt, multiple
  occurrences) and re-test it; do not inherit a single-consumer assumption like "one URL".
- **Give every redactor test a positive and a negative assertion:** the secret is gone
  *and* the surrounding non-secret text is preserved, so an over-broad future edit is also
  caught.
- **Bound the ReDoS probe too:** include a long input with no delimiter and assert the
  call completes within a budget, so the performance fix itself is pinned.

## Downstream Impact

### For 02-plan

- A unit that extracts or promotes a security helper must list the old→new behavioural
  contract in the plan and include a parity-test unit as a RED gate, not an afterthought.
- Freeze whether an anchor/bound is a performance or a coverage property; if both are in
  scope, split them into separate units.

### For 04-review

- On any diff touching a redactor/sanitizer, diff the regex/algorithm against the version
  it replaces and look specifically for added `\b`/`^`/`$`/`{n,m}` narrowing.
- Flag a sanitizer test whose only input is short and well-formed as unpinned; require an
  adversarial-input case whenever the function's input scope grew.
- Treat single-occurrence `exec`/string`replace` inside a function documented to sanitize
  "an excerpt" or "content" as a security finding (P0/P1), not a nit.

## Related solutions

- [`./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`](./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md)
  — *where* to sanitize (once at the boundary). This card is *how* the sanitizer must be
  re-proven when it is extracted for that boundary.
- [`../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md)
  — another shared guard reused across call sites; a reused helper inherits its callers'
  input variety, not its original one.
- [`./verify-fail-open-guard-contracts-harness-version-lifecycle-side-effects.md`](./verify-fail-open-guard-contracts-harness-version-lifecycle-side-effects.md)
  — the sibling finding set from the same review (the guard whose sanitizer regressed).

## Provenance

- **Source review:** `docs/reviews/2026-10-06-context-health-and-semantic-compaction.md`
  (H1 high; L3 low).
- **Plan:** `docs/plans/2026-10-06-context-health-and-semantic-compaction-plan.md`
  (AD-7 "the one conversation-excerpt sanitizer").
- **Source files:** `extensions/ce-core/utils/redact.ts` (`redactSecrets`,
  `CREDENTIAL_ASSIGNMENT`, `FIRST_URL`), `extensions/ce-core/drift/combine.ts` (original),
  `tests/compaction-guard-combine.test.ts` (`API_TOKEN=abc123`).
- **Status:** documented; the fix is a one-character anchor removal plus a parity test,
  deferred to `04-5-debug` / `03-work` because `04-review` is code-read-only.

## 🧠 Context Status

- **Health:** good — root cause is isolated to two lines in one pure helper; fix is small
  and testable.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/utils/redact.ts`,
  `tests/compaction-guard-combine.test.ts`,
  `docs/reviews/2026-10-06-context-health-and-semantic-compaction.md`
- **Recommendation for `06-docsync`:** record the "security helper extraction requires a
  parity test and no bundled anchors" rule where the sanitize-at-boundary rule is
  documented; carry the unfixed H1 into the pre-merge checklist.
