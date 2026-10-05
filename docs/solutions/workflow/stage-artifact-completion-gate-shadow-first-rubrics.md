---
title: Stage-Artifact Completion Gates Need Shadow-First Rubrics and Stage-Scoped Artifact Resolution
category: workflow
severity: high
tags:
  - pedstack
  - stage-gate
  - rubric
  - shadow-mode
  - enforce
  - deterministic-floor
  - fail-open
  - fail-closed
  - artifact-resolution
  - content-hash
  - freshness
  - glob
  - fallback
  - placeholder-predicate
  - record-schema
  - validation
  - jev
applies_when:
  - Adding or widening a deterministic predicate that gates a pipeline stage completion
  - Introducing a shadow/enforce (warn/block) mode switch for a workflow gate
  - Resolving "the artifact this stage produced" via globs or newest-file fallback
  - Persisting a content hash to prove a gate verdict is still fresh
  - Validating a persisted record to decide fail-open vs fail-closed
---

# Problem

A stage-completion gate that blocks cross-stage `context_handoff save` needs three things that
are easy to get subtly wrong:

1. **A safe rollout story.** "Shadow first" is not safe when part of the gate already blocks.
2. **An unambiguous definition of which artifact is being scored.** Globs and newest-file
   fallbacks both resolve the wrong file.
3. **A trustworthy persisted record.** Stale-by-construction hashes and unvalidated record
   elements silently defeat the gate in the opposite direction (deadlock or fail-open).

# Context

This surfaced in `pi-pedstack` while building issue #5 ("Jev: score stage artifacts and gate
completion"). The design (`docs/plans/2026-10-05-jev-stage-artifact-scoring-completion-gate-plan.md`,
AD-2) correctly separated two layers:

- **Deterministic floor** — pure per-stage predicates (artifact present, required headings, min
  length, no placeholders, review findings persisted, …) re-run on every completion save in
  **both** `shadow` and `enforce`.
- **Semantic verdict** — a bounded Jev score, recorded by the `stage_gate` tool; only `enforce`
  consumes it.

The review (`docs/reviews/2026-10-05-jev-stage-artifact-scoring-completion-gate.md`) then found
four high-severity defects, all reproduced against real in-repo artifacts:

| Id | Defect | Evidence |
|----|--------|----------|
| H1 | `ANGLE_PLACEHOLDER_PATTERN = /<[a-z][a-z0-9 _-]{2,}>/` rejects normal schema notation (`<string>`, `<sha256>`, `<div>`), so it blocks the brainstorm, the plan, and `docs/solutions/**` | `extensions/ce-core/stage-gate/rubrics.ts:66` |
| H2 | `isRecordFresh` re-resolves artifacts **without** the `artifactPaths` hint the evaluation used, so every hint-scored record is permanently stale and `enforce` deadlocks on a documented parameter | `extensions/ce-core/stage-gate/store.ts:130` vs `evidence.ts:199` |
| H3 | `resolveFallback` returns the newest file in a shared `artifactDir` with no stage filter, so `04-5-debug` and `06-docsync` both score `stage-reports/03-work.md` | `extensions/ce-core/stage-gate/evidence.ts:139` |
| H4 | `05-learn` globs `docs/solutions/**/*.md`, scoring the whole 48 KiB-capped corpus instead of the solution just written | `extensions/ce-core/stage-gate/rubrics.ts:357`, `evidence.ts` read cap |

Plus moderate/low companions: `PASS_MARKER = /(pass|passed|green|0 fail)/i` matches `bypass` /
`password` (M1), and `readRecord` casts `attempts as StageGateAttempt[]` without element validation,
so a malformed-but-parseable record throws inside `isRecordFresh` and the guard's catch **fails
open** — the opposite of the documented fail-closed contract (M2).

The deeper point: **shadow mode did not protect against H1/H3/H4.** The team expected shadow to be
a warn-only dry run; because the deterministic floor blocks in both modes, a too-broad predicate
blocks the whole pipeline immediately. "Shadow-first" only delays the *semantic* risk, not the
predicate risk.

# Solution

## 1. Treat the deterministic floor as production from the first release

Split rollout safety by layer, and say so explicitly:

- Semantic verdict: shadow ⇒ warning only; enforce ⇒ blocking.
- Deterministic floor: blocking in **both** modes, always, even against a fresh `accept` record.

This is the right design (it is what makes "hollow artifact rejected" true everywhere), but it means
every new deterministic predicate ships exercised against **the repo's own real artifacts**, not
just fixtures. Add a "run the rubric over this repository's actual artifacts" verification step to
any stage-gate change.

## 2. Narrow predicates to the shape you actually mean

Do not assert "contains no `<lowercase…>` token". Assert placeholder *vocabulary*:

```ts
const PLACEHOLDER_PATTERN = /(?:^|\W)(TODO|TBD|FIXME|XXX|lorem ipsum)(?:\W|$)/i;
const ANGLE_PLACEHOLDER_PATTERN =
  /<\s*(?:placeholder|fill[^>]*|your[^>]*|todo|tbd|xxx|name|example)\s*>/i;
```

Add passing fixtures for the notation you must not reject: `<string>`, `<sha256>`, `<div>`,
`Map<string, Foo>`. Same idea for verification markers: `pass` as a substring is not evidence;
anchor to a count or an explicit phrase (`/\b\d+\s+pass(?:ed|ing)?\b|\b0\s+fail\b|\ball tests pass\b/i`).

## 3. Resolve artifacts in exactly one place, with a stage-scoped identity

- **Fallback must be stage-scoped.** Never "newest file in the directory". Constrain to the stage's
  own filenames (e.g. `` `${stage}*.md` ``) or give each stage its own directory. A shared
  `stage-reports/` directory is a correctness bug, not a convenience.
- **A glob that can match many files must not be the identity.** For stages whose canonical artifact
  is "the one I just wrote" (`05-learn`), resolve the newest by mtime (or require the `artifactPaths`
  hint) rather than concatenating a whole corpus and truncating at 48 KiB.
- **Validate a hint against the stage's declared globs**, not just containment inside the stage dir —
  otherwise the model can pick any older/smaller file in that directory.

## 4. Freshness must replay the same resolution as evaluation

A content hash is only a freshness proof if both ends resolve identically. Persist the hint (or the
exact resolved path list) on the attempt and have `isRecordFresh` re-resolve **with the same hint**;
then additionally compare the freshly resolved path list against `record.artifacts` so
added/removed/renamed files still invalidate. Without this, any entry point that accepts a hint
deadlocks in `enforce`.

## 5. Validate persisted records element-by-element before trusting them

`JSON.parse` + an `as T[]` cast is not validation. A parseable but malformed record should make
`readRecord` return `null` (so `enforce` blocks), not throw (so the catch fails open). Require at
minimum: known `stage` key, `verdict`, `enforcing`, string `artifactsHash`, and an `artifacts`
array — drop invalid entries.

# Why this works

The gate has an asymmetric contract: it is the thing that decides whether the workflow may advance.
Any place where its inputs are less precise than its promises creates a defect in one of two
directions:

- **Over-broad predicate / wrong artifact** ⇒ fail-closed becomes fail-wrong: legitimate work is
  blocked and the "shadow" mode provides no protection, because the deterministic floor blocks
  regardless.
- **Stale-by-construction hash / unvalidated record** ⇒ fail-closed becomes fail-open or a
  deadlock: `enforce` either can never be satisfied, or a corrupt record slips through.

Root cause is the same in every case: **the gate's notion of "the artifact" and "the record" was
not a single, shared, stage-scoped identity.** Once resolution is defined once (stage-scoped, hint
replayed into freshness) and records are validated at the boundary, both failure directions close.

# Prevention

- When a gate has a warn/block mode switch, ask: *which layers block regardless of the switch?*
  List them, and require real-artifact verification for those layers before shipping.
- Freeze "the canonical artifact" per stage as an explicit, stage-scoped rule. Reject
  newest-file-in-shared-directory fallbacks in code review.
- Any content hash that proves freshness must be recomputed by the **same** function with the
  **same** inputs as the verdict that produced it. Add a RED test for "hint-scored accept is fresh
  and allowed in enforce".
- Never cast parsed persisted state to a domain type without validating it. A corrupt record must
  produce the *configured* outcome (block in enforce), not an exception that lands in a catch.
- Keep a "run the rubric over this repository" probe in the change's verification steps — it is
  what caught H1 within one review cycle.

## How future stages benefit

- **02-plan**: before freezing rubric predicates or artifact resolution, search this card; the
  checklist "real-artifact probe + stage-scoped identity + hint-replayed freshness + record
  validation" belongs in the plan's test diagram.
- **04-review**: use the defect table above as a review checklist for any new gate predicate or
  persisted record schema; specifically test shadow mode against real repository artifacts, because
  shadow does not protect the deterministic floor.

## Related solutions

- `docs/solutions/workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`
  — same extension, same fail-open/fail-closed precedence philosophy; that card covers *path
  classification*, this one covers *artifact resolution + gate record freshness*.
- `docs/solutions/workflow/tool-based-task-tracking-with-handoff-gating.md` — the save-side gate
  shape (`isCompletionSave`, cross-stage only) this gate reuses.
- `docs/solutions/workflow/requirements-vs-plan-signature-divergence.md` — the "local validation
  must not be stricter than upstream" rule that motivates narrowing placeholder predicates.
