---
title: Decode Child-Process Streams with StringDecoder to Preserve Multibyte Characters
category: integration
severity: medium
tags:
  - node
  - child-process
  - streaming
  - string-decoder
  - utf8
  - multibyte
  - encoding
  - stdout
  - silent-corruption
  - jev
  - testing
applies_when:
  - Reading `stdout`/`stderr` from `node:child_process` via `data` events
  - Accumulating a `Buffer` stream into a string with `.toString("utf8")` per chunk
  - Output is JSON or any text that must round-trip non-ASCII characters
  - Writing a regression test for stream decoding
---

# Problem

Decoding each `data` chunk with `Buffer.toString("utf8")` silently corrupts any multi-byte character whose bytes straddle a chunk boundary. Node emits pipe data at arbitrary byte boundaries, not at character boundaries, so a UTF-8 sequence can be split across two `data` events. Each half then decodes to the Unicode replacement character `U+FFFD`.

The corruption is **silent** for a JSON pipeline: `{"m":"🚀"}` mangled to `{"m":"���"}` still parses, so no error is raised — the mangled text just flows into answers, legends, and diagnostics.

Live probe splitting `{"m":"🚀"}` mid-emoji:

```text
Buffer.toString("utf8") per chunk   →  {"m":"���"}   (3× U+FFFD)
StringDecoder("utf8").write(...)    →  {"m":"🚀"}
```

# Context

In `extensions/ce-core/jev/process.ts`, `createStreamCapture()` accumulated child output chunk-by-chunk:

```typescript
const appendStdout = (chunk: Buffer): void => {
  if (stdoutTruncated) return;
  const take = Math.min(chunk.length, MAX_STREAM_BYTES - stdoutBytes);
  stdout += chunk.subarray(0, take).toString("utf8"); // ❌ decodes each chunk in isolation
  stdoutBytes += take;
  if (take < chunk.length) stdoutTruncated = true;
};
```

The JEV runtime pipes a JSON request/response through `stdin`/`stdout`, so user state, question text, and answer legends may contain arbitrary Unicode. Because the result still parsed as JSON, nothing in the test suite (which used ASCII/whole-buffer writes) caught it; a `04-review` reviewer found it by splitting an emoji across two synthetic `data` events.

# Solution

## Preferred: a `StringDecoder` per stream

`node:string_decoder` holds the trailing bytes of an incomplete sequence and prepends them to the next write, so a code point split across chunks is reassembled.

```typescript
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");

const appendStdout = (chunk: Buffer): void => {
  if (stdoutTruncated) return;
  const take = Math.min(chunk.length, MAX_STREAM_BYTES - stdoutBytes); // cap on RAW bytes
  stdout += decoder.write(chunk.subarray(0, take));
  stdoutBytes += take;
  if (take < chunk.length) stdoutTruncated = true;
};

// On close, flush any buffered partial bytes (should normally be empty):
stdout += decoder.end();
```

Keep byte accounting on the raw `Buffer.length` / `take`, **not** on the decoded string length — a multi-byte character has a smaller string length than byte length, so sizing off the string would under-count and over-read.

## Minimal alternative: let the stream decode for you

```typescript
child.stdout?.setEncoding("utf8"); // Node internally uses StringDecoder
child.stdout?.on("data", (text: string) => { /* text is safe */ });
```

This is the shortest correct fix when you do not need a byte cap. If you do cap, remember `text.length` is character count, so use `Buffer.byteLength(text, "utf8")` for the budget.

## Accept only if intentional

If truncation can only ever cut bytes and the consumer tolerates `U+FFFD`, that must be a documented decision — the default failure mode is silent data corruption, which is not an acceptable default.

# Why this works

- **UTF-8 is variable-width (1–4 bytes).** A chunk boundary can fall inside a sequence; decoding half a sequence in isolation yields `U+FFFD` and the other half yields another.
- **`StringDecoder` is stateful by design** — it is exactly the buffer Node's own string streams use, so using it matches platform behavior instead of reimplementing it (Ponytail rung 2: standard library already does this).
- **The bug hides behind successful parsing.** Any assertion that only checks "the JSON parsed" or "the field exists" passes; only a round-trip equality on non-ASCII text catches it.

# Prevention

- **Rule of thumb:** if you call `.toString("utf8")` inside an `on("data")` handler, you almost certainly want a `StringDecoder` (or `setEncoding`).
- **Keep byte caps on raw bytes.** Mixing decoded-string lengths with byte budgets is a second latent off-by-N.
- **Add a split-multibyte regression test** whenever you accumulate a stream:

```typescript
it("reassembles a code point split across data events", () => {
  const capture = createStreamCapture();
  const bytes = Buffer.from('{"m":"🚀"}', "utf8");
  const rocketStart = bytes.indexOf(0xf0);        // first byte of the 4-byte emoji
  capture.appendStdout(bytes.subarray(0, rocketStart + 2)); // split mid-sequence
  capture.appendStdout(bytes.subarray(rocketStart + 2));
  expect(capture.stdout).toBe('{"m":"🚀"}');       // not '{"m":"���"}'
});
```

- **Flush on close.** Call `decoder.end()` when the process settles so a final partial sequence is not dropped.
- **Cross-check the mock suite:** event-listener mocks must feed `Buffer` chunks (see [`../testing/child-process-event-listener-mock-for-pi-extension-tests.md`](../testing/child-process-event-listener-mock-for-pi-extension-tests.md)); a mock that passes whole strings will hide this class of bug.

## Downstream Impact

### For 02-plan

- When a plan reads a child-process stream into a string, name the decoder (`StringDecoder` or `setEncoding`) in the plan; do not leave it to implementation choice.
- Plan the split-multibyte regression test alongside the happy-path test.

### For 04-review

- Flag any `.toString("utf8")`/`.toString("utf-8")` inside a stream `data` handler as a probable encoding bug.
- Require a non-ASCII round-trip test (emoji or CJK) for stream-accumulator code; ASCII-only tests are insufficient evidence.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-commandcode-headless-runtime.md` (Finding M1)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T14-37-52-895Z-04-review-to-05-learn.md`
- **Source files:** `extensions/ce-core/jev/process.ts` (`createStreamCapture`), `tests/jev-process.test.ts`
- **Status:** finding identified in review; fix deferred to `04-5-debug` or consumer wiring (#4/#5). Related spec drift is captured in [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md).

## 🧠 Context Status

- **Health:** good — bounded impact (module inert), reusable Node-streaming lesson, `StringDecoder` fix is small and tested.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/jev/process.ts`, `tests/jev-process.test.ts`
- **Recommendation for `06-docsync`:** fold the `StringDecoder` fix into the `04-5-debug`/consumer-wiring task list and reference this card in the plan's follow-ups.
