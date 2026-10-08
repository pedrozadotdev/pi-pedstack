---
title: Model-Authored Plan Fields Are Untrusted Input — Contain Paths and Constrain Extraction
category: architecture
severity: high
tags:
  - pi-extension
  - docs-verification
  - untrusted-input
  - model-authored
  - plan-prose
  - path-containment
  - canonical-rel
  - is-inside
  - false-positive
  - extraction
  - jev
  - source-verification
  - stage-gate
  - pedstack
applies_when:
  - A runtime reads a model-authored artifact (plan, requirements, handoff) as structured input
  - Extracting package, module, or file names from free-form Markdown prose
  - Resolving a declared file path before exists / readFile / hash
  - An allowlist or regex decides what counts as a "real" dependency or package
  - Reviewing any module that parses agent-written Markdown
---

# Problem

The runtime source-driven-docs-verification guard reads the newest
`docs/plans/*.md`, extracts "the packages and files this unit touches", and then
uses those facts to decide whether a unit needs authoritative documentation
verification. Both halves of that extraction trusted model-written prose as if
it were typed data. Two review findings share this one root cause:

1. **Over-broad token extraction (H1).** `parsePlannedPackages`
   (`extensions/ce-core/docs-verification/units.ts`) collects every backticked
   token and accepts it when `isPackageName` matches
   `/^[a-z][a-z0-9._-]*$/` and is not in a short `NON_PACKAGES` set. Run over
   this repo's own plan it returns 50+ bogus "packages": `types.ts`, `units.ts`,
   `facts.ts`, `mode`, `status`, `record`, `waive`, `dependencies`, `import`,
   `require`, `null`, `off`, `shadow`, `enforce`, … Because `plannedFacts`
   produces a non-empty package list, `shortCircuitDecision`
   (`combine.ts`) never fires, so **every ordinary plan unit is sent to Jev**
   and can be assigned a `required`/`uncertain` obligation. The earlier
   real-artifact failure was even attributed to `typebox` — a package that is
   never extracted from the plan at all. The failure was fabricated entirely by
   false positives.

2. **Uncontained declared paths (H2).** `parseDeclaredFiles` applies only
   `looksLikePath` (contains a slash or an extension) and `toAbsolute` is
   `path.resolve(workspaceRoot, file)` (`facts.ts`). `declaredFileList` probes
   `deps.exists(...)` and `observedFacts` calls `deps.readFile(...)` for every
   existing declared file; `observedFileHashes` likewise reads
   `path.resolve(repoRoot, file.path)`. Nothing calls `canonicalRel` /
   `isInside` / `isEscapingSymlink`. Probe:
   `buildFacts({ declaredFiles: ["/etc/hostname"], … })` returns
   `exists: true` and the observed phase reads it. A plan can therefore name
   `../../…` or an absolute path and make the extension read and hash files
   outside the repository.

Both defects are invisible to a green suite, because every test used a
well-formed plan with ordinary code identifiers and repo-relative files.

# Context

This surfaced in `pi-pedstack` during `04-review` of issue #15 (runtime
source-driven documentation verification). The feature's whole purpose is to
derive deterministic facts **in TypeScript** from a plan and hand only a bounded
semantic question to Jev. The trust boundary was drawn in the wrong place: the
plan text is agent-authored (and can be influenced by a PR, a linked issue, or a
dependency), but the extractor treated it as if a typed API had produced it.

The two findings are the security/contract pair of one invariant:

| Finding | Untrusted value | Loose check | Correct check |
|---|---|---|---|
| H1 | backticked token in unit prose | `^[a-z][a-z0-9._-]*$` allowlist | intersect against the nearest manifest dependency set; reject path-shaped tokens |
| H2 | declared `Files` entry | `looksLikePath` only | `canonicalRel` + `isInside` (+ symlink check) before `exists`/`readFile` |

Related: [`apply-traversal-policy-to-expansion-roots.md`](./apply-traversal-policy-to-expansion-roots.md)
documents the same containment invariant for a recursive walker whose explicit
roots skipped the pruning policy. This card is the **model-declared-path**
variant: the untrusted input is not a CLI target but a field the agent wrote.

# Solution

## 1. Contain every declared path before it touches the filesystem

Canonicalize once and skip anything outside the repo — mirror the walker fix
(reuse the exported helpers; do not re-implement them weaker):

```ts
// facts.ts — one containment gate in front of every exists/readFile/hash
import { canonicalRel, isInside } from "../utils/repo-paths";

function safeRepoRel(repoRoot: string, declared: string): string | null {
  const rel = canonicalRel(repoRoot, declared); // normalizes + joins
  return isInside(rel) ? rel : null;            // reject ../ and absolute escapes
}

function declaredFileList(input, deps): DeclaredFile[] {
  return input.declaredFiles.flatMap((file) => {
    const rel = safeRepoRel(input.workspaceRoot, file);
    if (rel === null) return [];                // skip out-of-repo entries
    return [{ path: rel, exists: deps.exists(path.join(input.workspaceRoot, rel)) }];
  });
}
```

The same gate applies to `observedFacts` (`readFile`) and `observedFileHashes`.
`parseDeclaredFiles` may keep `looksLikePath`, but path shape is a cheap
pre-filter, not a security boundary.

## 2. Constrain extraction against a typed fact set, not a regex allowlist

A backticked token in prose is a *candidate*, never a fact. The only trustworthy
package names are those the repo actually declares:

```ts
// units.ts — extraction returns candidates; facts.ts decides membership
export function parsePlannedPackages(unitText: string): string[] {
  const out = new Set<string>();
  for (const m of unitText.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (looksLikePath(token)) continue;        // reject types.ts, a/b.ts
    if (!isPackageName(token)) continue;        // reject mode, status, off
    out.add(token);
  }
  for (const m of unitText.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi)) {
    if (isPackageName(m[0])) out.add(m[0]);
  }
  return [...out].sort();
}

// facts.ts — plannedFacts intersects with the manifest, exactly like observedFacts
const planned = parsePlannedPackages(input.unitText)
  .filter((name) => manifestNames.has(name) || name.startsWith("@"));
```

When there is no manifest at all, an unbacked token cannot justify a
`required` decision; treat it as version-unknown (→ at least `uncertain`) rather
than minting an obligation. A regex allowlist may gate *which* candidate to
probe, but only the manifest may promote a candidate to a fact.

## 3. Pin the boundary with adversarial tests, not happy-path tests

```text
plan prose: `types.ts`, `mode`, `status`, `off`, `shadow`  -> zero packages, zero Jev calls
plan prose: `typebox` where typebox is a manifest dependency -> one package fact
declaredFiles: ["/etc/hostname"], ["../../etc/passwd"]        -> no exists, no readFile
declaredFiles: ["src/a.ts"]                                   -> exists + read inside repo
```

If a test cannot distinguish "the extractor found the real dependency" from
"the extractor matched a code identifier", it does not exercise the boundary.

# Why this works

- **Model-authored Markdown is data, not a schema.** A plan heading and body are
  free text that the model composes from requirements, issue text, and file
  names. Treating it as structured input gives every downstream heuristic the
  model's own phrasing as an input — including its typos and examples.
- **A regex allowlist is a denylist in disguise.** `^[a-z][a-z0-9._-]*$` matches
  an unbounded set of English words and short identifiers. Enumerating
  exclusions (`NON_PACKAGES`) can never be complete; intersecting with the
  manifest is complete by construction.
- **Path shape is not path location.** `looksLikePath` answers "does this look
  like a path?", not "is this path inside the repo?". Only canonicalization plus
  a containment check answers the second, and `readFile` is what makes it matter.
- **False facts propagate.** A single bogus package turns a deterministic
  short-circuit into a Jev call, an obligation, and a `revise` verdict. The
  cheapest correct fix is to never mint the fact in the first place.

# Prevention

- **Name the trust boundary when planning any artifact-reading guard.** If the
  input is agent-written, the plan must say which fields are untrusted and which
  typed source (manifest, lockfile, config) promotes a value to a fact.
- **Route every declared path through one containment helper** before
  `exists`/`readFile`/`hash`; a shape check is not a substitute. Reuse
  `canonicalRel` / `isInside` / `isEscapingSymlink` from `utils/repo-paths.ts`.
- **Intersect prose-derived candidates against a manifest/lockfile set.** Never
  let a regex allowlist alone produce a `required` decision or a Jev call.
- **Add one adversarial row per untrusted field**: an out-of-repo absolute path,
  a `../` escape, and a code-identifier false positive. A plan-shaped happy-path
  test will pass while both defects are live.
- **In `04-review`, probe the built extractor with a realistic plan** (the
  repo's own `docs/plans/*.md`) and print what it extracted, instead of reading
  the diff. A 50+ item "package" list is obvious the moment it is printed.

# Related solutions

**Overlap check:** no High-overlap card exists. Closest cards are **Moderate**
(same invariant, different input source) and are cross-linked below.

- [`apply-traversal-policy-to-expansion-roots.md`](./apply-traversal-policy-to-expansion-roots.md)
  — same "containment must hold at every entry point" invariant for a recursive
  walker; this card adds the model-declared-path entry point.
- [`sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md`](./sanitize-untrusted-provenance-at-one-boundary-before-every-egress.md)
  — the same "one boundary, every consumer" discipline applied to redaction
  rather than containment.
- [`one-freshness-predicate-reused-at-every-read-site.md`](./one-freshness-predicate-reused-at-every-read-site.md)
  — the read-site reuse discipline; a declared file must also be judged by one
  containment predicate, not per call site.
- [`../workflow/requirements-vs-plan-signature-divergence.md`](../workflow/requirements-vs-plan-signature-divergence.md)
  — the same review's doc-vs-code divergences (dead carry-over, hook scope).

# Downstream Impact

### For 02-plan

- For every unit that reads a model-authored artifact, add a row naming the
  untrusted fields and the typed source that promotes them to facts.
- Budget a containment helper (`canonicalRel` + `isInside`) as the single path
  gate; make "all path consumers go through it" part of the frozen signature.
- Add the adversarial test rows (absolute path, `../` escape, identifier false
  positive) to the test diagram for the extraction/facts unit.

### For 04-review

- **Print what the extractor extracts from a realistic artifact** and sanity
  check the list; do not rely on the unit tests' fixtures.
- **Flag any `readFile`/`exists` whose path is derived from plan, handoff, or
  prompt text without a preceding containment check.**
- **Flag any regex allowlist that can promote a prose token to a decision**
  (package, dependency, risk, severity) without intersecting a typed source.

# Provenance

- **Issue:** [#15 — make source-driven documentation verification a runtime trigger](https://github.com/pedrozadotdev/pi-pedstack/issues/15)
- **Source review:** `docs/reviews/2026-10-06-runtime-source-driven-docs-verification.md` (H1, H2)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-06T14-24-53-939Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-06-runtime-source-driven-docs-verification-requirements.md` (deterministic-facts section, external-package boundary)
- **Plan:** `docs/plans/2026-10-06-runtime-source-driven-docs-verification.md` (Unit 1 extraction, Unit 2 facts)
- **Source files:**
  - `extensions/ce-core/docs-verification/units.ts` — `parsePlannedPackages`, `isPackageName`, `NON_PACKAGES`, `parseDeclaredFiles`, `looksLikePath`
  - `extensions/ce-core/docs-verification/facts.ts` — `toAbsolute`, `declaredFileList`, `plannedFacts`, `observedFacts`, `observedFileHashes`
  - `extensions/ce-core/utils/repo-paths.ts` — `canonicalRel`, `isInside`
  - `extensions/ce-core/stage-gate/evidence.ts` — `collectObligations` (`planHasExternalPackages`)
- **Status:** findings deferred to an on-demand `04-5-debug` pass; both are live
  when the guard runs, but the feature is shadow-first and unreleased.

## 🧠 Context Status

- **Health:** good — the learning is captured; H1/H2 are time-boxed to a
  `04-5-debug` pass before the docs-verification guard is trusted in `enforce`.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/architecture/validate-model-authored-plan-fields-before-read-or-extract.md`,
  `extensions/ce-core/docs-verification/units.ts`,
  `extensions/ce-core/docs-verification/facts.ts`,
  `extensions/ce-core/utils/repo-paths.ts`,
  `docs/reviews/2026-10-06-runtime-source-driven-docs-verification.md`
- **Recommendation for `06-docsync`:** carry the "plan prose is untrusted input"
  rule into `CONTEXT.md` docs-verification vocabulary, and keep the H1/H2 fix
  note next to the shadow-first mode switch until the guard is trusted in
  `enforce`.
