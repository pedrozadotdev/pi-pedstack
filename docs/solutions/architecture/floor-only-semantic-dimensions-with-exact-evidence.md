---
title: Adding Semantic Dimensions to an Existing Gate — Floor-Only, Independently Shadowed, Exact Evidence
category: architecture
severity: high
tags:
  - pi-extension
  - stage-gate
  - jev
  - semantic-dimensions
  - floor-only
  - weighted-average
  - shadow-first
  - independent-mode-flag
  - calibration
  - baseline-resolution
  - deterministic-facts
  - evidence-precision
  - absent-vs-unreadable
  - section-aware-diff
  - source-provenance
  - degraded-mode
  - trim-ladder
  - ponytail
  - yagni
  - overengineering
applies_when:
  - Adding new semantic/LLM-scored dimensions to an existing deterministic gate that already produces a verdict
  - A new judgment must be calibratable without changing any existing verdict on day one
  - An LLM judge is fed evidence extracted deterministically from a diff, manifests, or the filesystem
  - Deciding how conditional evidence and size-trimming interact with a persisted verdict record
  - Reviewing a "signal" whose calibration counter or agreement gate feeds a future enforcement flip
---

# Problem

The Ponytail/YAGNI discipline was injected as **prose only** into the `02-plan`, `03-work`,
`04-review`, and `04-5-debug` system prompts. Nothing independently checked whether an artifact
added only *justified* complexity. The natural fix — "add a semantic check" — has three traps:

1. **A new dimension changes existing verdicts.** If the four new scores enter the shared average,
   every historical accept/review/revise boundary moves before anyone has calibrated the new
   judgment.
2. **The single shared shadow flag couples unrelated risk.** If the new dimensions ride
   `PEDSTACK_STAGE_GATE`, enabling the existing gate also enables an uncalibrated judgment (or
   vice versa).
3. **An LLM judge is only as good as the deterministic evidence it is fed.** The gate state had
   *no* notion of the stage's requirements/plan baseline, and the diff/manifest facts extracted to
   supply one can be silently wrong in ways that make the judge confidently wrong.

This card is the reusable shape that closes all three, plus the concrete evidence-precision
pitfalls the `04-review` pass found in the first implementation.

# Context

Feature #16 ("Jev: semantic Ponytail/YAGNI overengineering signal", roadmap milestone C) added a
thin composer that supplies what `stage_gate` lacked — a per-stage **baseline** and
**deterministic complexity facts** — and exposes four positive dimensions:

```text
extensions/ce-core/overengineering/
  types.ts       # frozen ids, skip reasons, facts/signal/record shapes
  baseline.ts    # per-stage normative excerpt (requirements/plan), file-based only
  facts.ts       # pure diff/manifest/untracked extraction, injected git runner
  compose.ts     # baseline -> facts -> signal; mode resolution; all-skipped rule
  shadow-log.ts  # D10 calibration log (line-count rotation)
extensions/ce-core/stage-gate/
  combine.ts     # OVERENGINEERING_FLOOR + floor-only partition
  evaluate.ts    # conditional request injection + schema-2 record
  rubrics.ts     # the four dimensions on plan/work/review
  store.ts       # freshness covers baseline content
```

The decision is recorded in `docs/adr/0001-overengineering-signal-as-stage-gate-dimensions.md`.
The signal ships **inert**: `PEDSTACK_OVERENGINEERING = off | shadow | enforce`, default `shadow`,
independent of `PEDSTACK_STAGE_GATE`. The `04-review` pass (`docs/reviews/2026-10-06-jev-semantic-ponytail-yagni-overengineering.md`)
confirmed the feature and found 1 high + 2 moderate + 4 low findings — all in the **deterministic
evidence** path, not in the gate integration. Those findings are recorded here as the prevention
checklist; they were deferred to `04-5-debug` and were **not** fixed at capture time.

# Solution

## 1. Make the new dimensions floor-only, never averageable

Partition the semantic scores into *base* and *overengineering* before any aggregation:

```ts
// extensions/ce-core/stage-gate/combine.ts
export const OVERENGINEERING_FLOOR = 0.5;

const weightedScore = weightedAverage(base);          // the four dims are NOT in `base`
const belowFloor = base.some((e) => e.normalized < DIM_FLOOR);
const overengineeringFailed =
  input.overengineeringEnforced === true &&
  present.length >= 1 &&                               // quorum: >=1 present dim
  present.some((e) => e.normalized < OVERENGINEERING_FLOOR);

if (weightedScore >= T_ACCEPT && !belowFloor && !overengineeringFailed) verdict = "accept";
```

A new judgment may only *lower* a verdict, and only when explicitly enforced. With enforcement
off, the four dims are still scored and recorded (`sem` contains them for calibration) but
`weightedScore` and `verdict` are **identical** to a run where they are absent. This is what makes
"ship inert" true rather than aspirational.

Two boundaries worth freezing explicitly:
- **Quorum:** `present.length >= 1` — zero present dims is the all-skipped rule (signal
  `unavailable`), not "pass by default".
- **Denominator for calibration ≠ denominator for the floor.** D10's agreement gate counts only
  runs with ≥3 present dims; the floor triggers on ≥1. Do not reuse one number for both.

## 2. Own shadow flag per uncalibrated judgment

`resolveOverengineeringMode` reads only `PEDSTACK_OVERENGINEERING`, defaults to `shadow`, and is
resolved once at init. The existing `PEDSTACK_STAGE_GATE` continues to govern the *base* semantic
verdict. Two flags is deliberate: the calibration exit condition is signal-specific, and an outage
or miscalibration of one must not drag the other. An invalid value resolves to `shadow`, never
`off` (a typo must not silently disable the calibration data collection).

## 3. Supply the baseline deterministically — never a network fetch

An LLM cannot judge "unrequested" or "scope broadening" without seeing the request. Resolve the
per-stage normative excerpt from files (`resolveBaseline`), with the terminal fallback being
`unavailable` — never a `gh` call. A network call inside a save-gating path is untestable and can
hang; the issue body is already paraphrased into the requirements doc.

`composeOverengineeringSignal` resolves the baseline **first**; an unavailable baseline
short-circuits to `unavailable` with **no git call** (`compose.ts`). `off` performs no reads at
all. This ordering is a testable contract, not an optimization.

## 4. Feed the judge exact evidence — the review findings

The `04-review` findings are all evidence-precision bugs. They are the reason this card exists.

### 4a. "Absent" is not "unreadable" (High, H1)

`tryRead` collapses ENOENT and EACCES into the same `null`, so a workspace directory that simply
has **no** `package.json` is recorded as `package_json_unreadable` and permanently skips
`dependency_justification`:

```text
# live worktree probe
skippedDimensions: [{dimension: "dependency_justification", reason: "package_json_unreadable"}]
# ...even though the readable root package.json declares the full dependency set
```

`stat` the path first (or catch `ENOENT` separately) and only call `skipUnreadableManifest` when
the file **exists but cannot be read**. An absent workspace manifest is ignored, not recorded as a
failure. (`extensions/ce-core/overengineering/facts.ts:324`,`:339`,`:332`.)

### 4b. Diff-hunk line extraction must be section-aware (Moderate, M1)

`manifestDependencies` matches any added `"key": "value"` line in a manifest hunk and only filters
a top-level key allowlist, so scripts and nested keys become fake dependencies:

```text
+    "dev": "bun --watch src/index.ts",
+    "exports": {
+      ".": "./dist/index.js",
→ newDependencies: [".","dev"]
```

`newDependencies` is the `dependency_justification` evidence, so the judge can be told a script
name is an unjustified dependency. Track the enclosing `dependencies`/`devDependencies`/… section
across the hunk, or derive `newDependencies` only from undeclared external import specifiers
(already computed separately). (`facts.ts:398`.)

### 4c. Provenance must separate an outage from a reading (Moderate, M2)

`toOverengineeringRecord` set `source: "jev"` whenever the signal was `ready` and not too large,
**without consulting `outcome.unavailable`**. A Jev outage therefore produced a `source: "jev"`
record with zero dims — poisoning the D10 calibration counter that decides the enforcement flip:

```text
# throwing JevRuntime probe
jevUnavailable: true   verdict: accept   record.overengineering.source: "jev"   record.sem.length: 0
```

Thread `outcome.unavailable` into the record and map a ready-but-degraded run to
`"unavailable"` (or an explicit `"degraded"`). A calibration counter must only count actual
readings. (`extensions/ce-core/stage-gate/evaluate.ts:309`,`:319`.) This is a recurrence of
[`keep-degraded-fallbacks-out-of-primary-signal-state.md`](./keep-degraded-fallbacks-out-of-primary-signal-state.md)
in a parallel feature — the pattern is known, and it still shipped again.

### 4d. Persist what was actually sent (Low, L1)

When the size trim ladder drops the four questions (`includeOver: false`), the persisted record
still carried the **full untrimmed** `diffExcerpt`, because `let facts = signal.facts` was only
overwritten inside `if (includeOver)`. The field's own doc says it is "the excerpt actually
injected after trimming". Persist the trimmed/empty excerpt so the record reflects the request and
does not bloat. (`evaluate.ts:156`.)

### 4e. Truncation counts must be complete, and dead union arms removed (Low, L2/L3)

- Slicing `untracked` to `MAX_UNTRACKED_FILES` before the loop means entries beyond the cap are
  silently dropped and never counted in `truncated.untrackedSkipped` — `facts.truncated` then lies
  about what was omitted. (`facts.ts:424`.)
- `unavailable(reason: "no_baseline" | "request_too_large")` declared a union arm no call site
  passes (the size path lives in `evaluate.ts`). Prefer deletion over keeping an unreachable arm.
  (`compose.ts:46`.)

### 4f. Protected-tag rules must not match "almost everything" (Low, L4)

`PROTECTED_RULES` tags `error_handling` on `throw|catch|Error` over the joined added-lines
haystack, so nearly every TS change is "protected complexity" and the "must not be penalized"
instruction is near-always in play. The tag is context-only, never an automatic pass, but a
near-universal tag is noise. Narrow it (path patterns, or a bounded ratio of added scaffolding
lines). (`facts.ts:89`.)

## 5. One entry point, injectable I/O, no throw

`composeOverengineeringSignal` is the only composition entry point. `extractComplexityFacts`
takes an injected `runGit` (production: `execFile` with a 2 s timeout), never throws, and degrades
a git failure to empty facts plus a skip reason. `off` and missing-baseline paths never spawn git.
All I/O is injectable, so every branch is testable without a live Jev or git.

# Why this works

- **Floor-only decouples "measure" from "change the outcome".** A new judgment enters the record
  and the calibration log, but not the average, so no historical verdict boundary moves.
- **A separate flag makes the exit condition enforceable.** One flag per uncalibrated judgment
  means enabling the base gate cannot accidentally enforce an unrelated signal.
- **Deterministic evidence is the actual failure surface.** Every confirmed finding was in
  `facts.ts`/`evaluate.ts` bookkeeping, not in the gate partition or the fail-open contract —
  because an LLM judge amplifies a wrong fact into a confident wrong verdict.
- **Absent ≠ unreadable ≠ degraded.** Three distinct states (nothing there / could not read /
  runtime down) collapsed into two booleans is exactly what turns a measurement into
  misinformation. Keep all three distinct and named.
- **The record is evidence, not a cache of intent.** If it claims to hold "what was sent", the
  trim ladder must write through to it.

# Prevention

- **Never let an uncalibrated dimension into the shared aggregate.** Partition scores; give the
  new set its own floor and its own mode flag. Prove with a test that `weightedScore`/`verdict`
  are byte-identical when enforcement is off.
- **State the enforcement exit condition when you ship shadow.** "Shadow-first" without a criterion
  becomes "never enforce"; the calibration log must be able to count *real* readings only.
- **Distinguish `ENOENT` from read errors at the read boundary.** Any "unreadable" skip reason must
  mean the file exists and cannot be read. Add a repo-shaped fixture with a directory that has no
  manifest.
- **Make any extraction from a diff section-aware.** Never regex added lines globally; track the
  enclosing YAML/JSON/TOML section before recording a fact.
- **Count every truncation.** If a cap drops entries, increment the corresponding `truncated`
  counter (including entries beyond a pre-slice cap) — or remove the `truncated` field.
- **Map runtime outage to a non-reading provenance.** Thread `unavailable`/`degraded` into every
  persisted `source`; a counter or agreement gate must branch on provenance, never on the value.
- **Persist the post-trim payload.** If a size ladder reduces what is sent, write the reduced form
  to the record.
- **Exercise the composer against this repository's own artifacts**, not only fixtures. The H1
  probe that found the misread was `extractComplexityFacts` on the live worktree.

# Downstream Impact

### For `02-plan`

- When a plan adds semantic dimensions to an existing verdict, require three units: the
  floor-only partition (+ a "verdict unchanged when enforcing=false" test), the independent mode
  flag, and the deterministic evidence extractor with its own failure-mode table.
- Put "run the extractor over this repository" in the verification steps next to the real-artifact
  rubric probe.
- Freeze `absent-vs-unreadable`, `section-aware extraction`, and `outage provenance` as
  acceptance criteria in the evidence unit, not as review follow-ups.

### For `04-review`

- Open every file that extracts facts for an LLM judge and ask: *can this mark an existing-but-
  unparsed thing as a failure, and can it misattribute a line to the wrong section?*
- Check the persisted record's `source` against the runtime's `unavailable` flag — an outage must
  not increment a calibration reading.
- Verify the trim ladder and the persisted facts describe the same bytes.
- Confirm the new dimensions are absent from the weighted average and that a single present dim
  below the floor blocks `accept` only under enforcement.

# Related learnings

- [`../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md`](../workflow/stage-artifact-completion-gate-shadow-first-rubrics.md)
  — the gate's deterministic floor blocks in both shadow and enforce, and predicates must be
  narrowed to the exact shape; this card applies the same "shadow does not protect everything"
  rule to *semantic* dimensions and their *evidence*.
- [`shadow-first-semantic-ranking-with-deterministic-fallback.md`](./shadow-first-semantic-ranking-with-deterministic-fallback.md)
  — shadow-first + never-weaker fallback; this card adds the per-judgment flag and the
  floor-only partition for a signal that *augments* an existing verdict instead of replacing a
  path.
- [`keep-degraded-fallbacks-out-of-primary-signal-state.md`](./keep-degraded-fallbacks-out-of-primary-signal-state.md)
  — the provenance rule M2 violates; this is a recurrence, which is itself the lesson.
- [`one-freshness-predicate-reused-at-every-read-site.md`](./one-freshness-predicate-reused-at-every-read-site.md)
  — baseline content was folded into the one freshness predicate rather than a second one.

# Provenance

- **Issue:** [#16 — Jev: semantic Ponytail/YAGNI overengineering signal](https://github.com/pedrozadotdev/pi-pedstack/issues/16)
- **Requirements:** `docs/brainstorms/2026-10-06-jev-semantic-ponytail-yagni-overengineering-requirements.md` (D1–D12)
- **Plan:** `docs/plans/2026-10-06-jev-semantic-ponytail-yagni-overengineering-plan.md` (Units 1–9)
- **ADR:** `docs/adr/0001-overengineering-signal-as-stage-gate-dimensions.md`
- **Source review:** `docs/reviews/2026-10-06-jev-semantic-ponytail-yagni-overengineering.md` (H1, M1, M2, L1–L4)
- **Source files:**
  - `extensions/ce-core/stage-gate/combine.ts` — `OVERENGINEERING_FLOOR`, floor-only partition
  - `extensions/ce-core/stage-gate/evaluate.ts` — conditional injection, `toOverengineeringRecord`
  - `extensions/ce-core/overengineering/facts.ts` — `tryRead`, `manifestDependencies`, `readUntracked`
  - `extensions/ce-core/overengineering/compose.ts` — mode resolution, baseline-first ordering
- **Verification at capture:** `bun test` → 1192 pass / 2 skip / 0 fail; `bunx tsc --noEmit` clean;
  `fallow_audit base=HEAD gate=new-only` → no issues in 39 changed files.
- **Status:** the four dimensions ship **inert** (shadow). H1/M1/M2/L1–L4 are open and deferred to
  `04-5-debug`; they do not block merge while the signal changes no verdict.

## 🧠 Context Status

- **Health:** good — the design learning and the evidence-precision checklist are captured; the
  signal is inert and the deferred findings are time-boxed to the enforcement checkpoint.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `extensions/ce-core/overengineering/facts.ts`,
  `extensions/ce-core/overengineering/compose.ts`,
  `extensions/ce-core/stage-gate/evaluate.ts`,
  `extensions/ce-core/stage-gate/combine.ts`
- **Recommendation for `06-docsync`:** link this card from the overengineering feature paragraph in
  `AGENTS.md`; carry the H1/M1/M2 fix note (and the `wrap up`/`PEDSTACK_OVERENGINEERING` env var)
  into the docs sync and the D10 enforcement checkpoint.
