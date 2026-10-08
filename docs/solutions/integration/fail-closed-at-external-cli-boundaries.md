---
title: Fail Closed at External CLI Boundaries — Preserve Bytes, Match Native IDs, Validate Literal Output
category: integration
severity: high
tags:
  - agy
  - gemini
  - external-cli
  - child-process
  - utf8
  - raw-bytes
  - exact-model-id
  - tsv
  - schema-validation
  - severity
  - read-only-reviewer
  - fail-closed
  - sidecar
  - pi-pedstack
applies_when:
  - A CLI adapter uses streamed input or output to authorize paths, tools, identities, or results
  - UTF-8 boundaries can split across child-process chunks and malformed input must be rejected
  - A native CLI lists model identifiers in a format that differs from configured model strings
  - Model-authored JSON is normalized before it can be persisted as a successful result
  - A process exit code or status field is being treated as proof that a security hook ran completely
---

# Problem

The Gemini `agy` reviewer integration had three independent false-success paths in its external
CLI boundary. A 04-review pass rechecked and confirmed all three were fixed:

1. **Chunk-wise UTF-8 decoding changed authorization data.** The guard decoded each stdin chunk
   independently. When a multibyte character in a path was split between chunks, replacement
   characters changed the path before symlink/path validation. Child output had the same corruption
   risk. The prior tests did not exercise the shipped guard executable with an actual chunk split.
2. **The model catalogue format was mistaken for the configured model identifier.** Native
   `agy models` rows are tab-separated. Treating the whole row as an ID or stripping provider
   prefixes could turn an unavailable configured model into an alias or fallback.
3. **Coercion hid malformed findings.** Converting a severity with `String(value)` accepted
   numbers and other non-string JSON values as if they were valid severity text. A malformed
   finding array could otherwise be mistaken for a successful review and persisted.

These are variations of one integration hazard: permissive normalization erased distinctions that
were part of the security and persistence contract.

# Context

This surfaced in the Gemini reviewer work, where a selected reviewer is launched through `agy`
with a separate read-only plugin guard. The review report records the fixes and their regressions:
`docs/reviews/2026-10-07-gemini-agy-readonly-reviewers.md`. The report's current outcome is clean
(zero findings); it explicitly does **not** claim a native full guarded-review E2E or Windows
validation.

The review confirmed three earlier defects against the final source and tests: UTF-8 handling,
exact model-catalogue matching, and literal severity validation. The implementation now rejects
malformed encoding and output, rejects unavailable IDs before the challenge, and does not write a
success sidecar for malformed findings. A CLI success status alone is still not evidence that its
guard ran or that every proposed tool call was accounted for.

# Solution

## 1. Keep authorization streams as bytes until the complete bounded stream is available

Apply the byte limit to `Buffer.length`, not decoded string length. Accumulate raw chunks, then
validate/decode once with fatal UTF-8 semantics before interpreting security-sensitive input:

```ts
const bytes = Buffer.concat(chunks);
const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
```

For child-process output, likewise retain bounded raw stdout/stderr and decode after process close.
Invalid encoding, truncation, timeout, or a failed process is a failed review—not a repaired string.
The actual bundled guard executable should be tested with the same valid JSON split both at and away
from a multibyte boundary, plus malformed bytes; assert authorization behavior, not merely decode
success.

`StringDecoder` is appropriate when a stream needs lossless incremental decoding and replacement of
invalid sequences is acceptable. For authorization or identity input, use whole-buffer fatal
validation so malformed bytes cannot be silently repaired into another path or identifier.

## 2. Parse the native identifier field and compare it exactly

Read the documented/probed row format, extract only the identifier field (for the verified agy
TSV shape, the first tab-separated field), and compare it to the unchanged configured model ID.
Do not strip provider prefixes, normalize aliases, select a default, or fall back to another model.
Test both a native-shaped available row and an unavailable row, and prove rejection occurs before
starting the guarded review.

## 3. Validate original JSON values before persistence

Validate each field's original type and allowed literal. For example, severity must already be the
string literal `high`, `moderate`, or `low`; never coerce it into one. Parse and validate the entire
findings array before persistence. A valid first finding followed by one malformed finding must
reject the whole response and leave the success sidecar absent. A successful empty array is valid
only after all process, guard, transcript, and schema checks pass.

## 4. Treat native success as one input, not a completion certificate

A zero exit code or `status: SUCCESS` does not prove a native plugin activated, a hook denied the
challenge, or all tool calls reached a healthy Stop. Require preflight of the exact model/plugin
assets, a disposable effective-hook challenge, and parent-side reconciliation of transcript calls
against guard lifecycle records. Missing, duplicate, malformed, truncated, or unresolved records
make the review incomplete and prevent success persistence.

# Why this works

- **Byte boundaries are not character boundaries.** Decoding chunks independently can change valid
  UTF-8; fatal whole-stream decoding also distinguishes malformed bytes from valid text.
- **Identifiers are contracts, not suggestions.** Exact comparison preserves config precedence and
  avoids accidentally reviewing with a different model than the operator selected.
- **Coercion is not validation.** A string representation of a value is not proof that the original
  JSON value had the required type.
- **Process completion is weaker than task completion.** External CLIs may report success despite a
  missing or failed hook; independent lifecycle and transcript evidence is needed before writing a
  success artifact.

# Prevention

- Cap raw bytes before decoding; test actual executable stdin and child output with split multibyte
  characters and malformed UTF-8.
- Derive parsing from the real native CLI contract and compare the unchanged configured identifier
  exactly; test unavailable IDs and prove there is no alias/default fallback.
- Reject wrong JSON types instead of coercing them. Validate the whole response before writing any
  findings sidecar; include valid-then-invalid and empty-success cases.
- Exercise the effective hook and failure lifecycle, not only mocked command success or status text.
- Carry explicit non-coverage into reports: an opt-in integration test that was skipped is not a
  native end-to-end result, and Linux evidence does not imply Windows support.

## Downstream Impact

### For 02-plan

- Freeze the external CLI's observed output shape and byte/encoding policy in the plan; mark which
  values must be exact and which malformed forms abort.
- Add adversarial tests at each boundary: chunk-split and malformed UTF-8, available/unavailable
  native model rows, wrong JSON primitive types, a valid-then-invalid findings array, and no-sidecar
  on any failure.
- Separate process success from verified guard/lifecycle completion in the acceptance criteria.

### For 04-review

- Trace bytes to the point of decode; flag per-chunk `Buffer.toString("utf8")` where text controls
  authorization or persistence.
- Compare the configured model against the native identifier field, not a guessed CLI rendering.
- Check original JSON types and ensure malformed later items cannot leave partial success artifacts.
- Verify the guard challenge and call-accounting evidence; do not accept exit 0 or `SUCCESS` alone.

## Related solutions

- [`decoding-child-process-streams-with-stringdecoder.md`](decoding-child-process-streams-with-stringdecoder.md)
  — moderate overlap: same split-UTF-8 stream hazard. This card adds fatal decoding and actual
  authorization-path behavior where replacement is unsafe.
- [`../architecture/verify-fail-open-guard-contracts-harness-version-lifecycle-side-effects.md`](../architecture/verify-fail-open-guard-contracts-harness-version-lifecycle-side-effects.md)
  — verify the actual runtime/hook lifecycle instead of inferring capability from declarations.
- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — external/native input contracts must not be narrowed or guessed from local assumptions.
- [`../workflow/model-facing-result-contracts-must-enumerate-every-outcome.md`](../workflow/model-facing-result-contracts-must-enumerate-every-outcome.md)
  — enumerate malformed, empty, and incomplete outcomes honestly.
- [`../workflow/agentic-sub-reviewers-need-tool-prohibition-and-line-evidence.md`](../workflow/agentic-sub-reviewers-need-tool-prohibition-and-line-evidence.md)
  — reviewer output is untrusted and must satisfy a validated evidence contract.

## Overlap check

`solution_search` in overlap mode returned no relevant duplicate/overlap cards and separately flagged
`deterministic-path-classification-guard-for-stage-scoped-tool-calls.md` as a potential conflict.
That card concerns the pipeline's stage-scoped `write`/`edit` policy and intentionally fails open for
unknown path classes; this card concerns an external reviewer boundary that must fail closed when
encoding, model identity, or lifecycle completion is unproven. The different callers and policies
are not contradictory. The existing child-process UTF-8 card is a related but distinct case: it
recommends incremental `StringDecoder` for general output preservation, while authorization data
here requires fatal rejection of malformed input.

## Provenance

- **Source review:** `docs/reviews/2026-10-07-gemini-agy-readonly-reviewers.md` — clean outcome;
  reverified and closed three prior findings (UTF-8 input/output, exact native model ID, literal
  severity validation).
- **Requirements:** `docs/brainstorms/2026-10-07-gemini-agy-readonly-reviewers-requirements.md`.
- **Plan:** `docs/plans/2026-10-07-gemini-agy-readonly-reviewers-plan.md`.
- **Source files:** `extensions/ce-core/review/agy-guard.ts`, `extensions/ce-core/review/agy-runner.ts`,
  `extensions/ce-core/tools/multi-reviewer.ts`.
- **Regression tests:** `tests/agy-guard.test.ts`, `tests/agy-runner.test.ts`,
  `tests/multi-reviewer-agy.test.ts`.
- **Verification recorded by review:** `bun test` — 1,886 passed / 3 skipped / 0 failed;
  `bun x tsc --noEmit` clean; generated guard bundle matched its TypeScript build. Native guarded
  end-to-end and Windows validation were not run.

## 🧠 Context Status

- **Health:** good — three previously confirmed adapter defects have regressions and a fresh review
  recorded zero findings; native E2E and Windows remain explicitly unverified.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md` (updated at stage completion).
- **Active files:** `docs/solutions/integration/fail-closed-at-external-cli-boundaries.md`,
  `docs/reviews/2026-10-07-gemini-agy-readonly-reviewers.md`,
  `docs/plans/2026-10-07-gemini-agy-readonly-reviewers-plan.md`,
  `docs/brainstorms/2026-10-07-gemini-agy-readonly-reviewers-requirements.md`.
- **Recommendation for `06-docsync`:** complete deferred Unit 6 by documenting explicit plugin
  installation, supported agy/runtime prerequisites, exact model IDs, fail-closed abort behavior,
  incomplete-review handling, and cleanup in the operator documentation; keep native E2E and Windows
  limitations explicit.
