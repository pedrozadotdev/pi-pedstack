---
title: Apply Traversal Policy to Expansion Roots, Not Just Discovered Children
category: architecture
severity: high
tags:
  - pi-extension
  - repo-walk
  - directory-pruning
  - symlink
  - realpath
  - path-containment
  - glob
  - entry-point
  - candidate-expansion
  - silent-drop
  - prototype-key
  - object-create-null
  - semantic-scout
  - pedstack
applies_when:
  - Building or reviewing a recursive repository walk that prunes directories or caps results
  - A helper applies a policy to discovered children but is also entered with an explicit root or target
  - Expanding globs or literal paths into a candidate set for scouting or search
  - Enforcing "never follow symlinks" or "stay inside repoRoot" during traversal
  - Keying a map by filesystem-derived candidate paths
---

# Problem

A recursive repo walk is only as safe as its **entry points**. When pruning and
containment are implemented inside the loop that iterates *children*, any code
path that hands the walker a directory directly skips the policy. Three defects
in the same expansion pipeline (`extensions/ce-core/utils/semantic-file-ask.ts`)
showed the three ways a candidate set silently stops matching its own rules:

1. **Pruning applied only to children, never to the explicit root.** `walkFiles`
   skips an entry whose name is in `PRUNED_DIRS` (`semantic-file-ask.ts:759`),
   but a literal target that *is* a pruned directory is walked anyway.
   `expandOneTarget` → `addLiteralTarget` → `addWalked` calls
   `walkFiles(abs, rel, …)` on the target root, so `targets: ["node_modules"]`
   returned `totalFound=1` and `results: ["node_modules/pkg/index.js"]` while
   `targets: ["."]` skipped the same tree.
2. **Containment applied to file symlinks but not to a glob base.**
   `addGlobMatches` calls `walkFiles(path.join(repoRoot, base), base, …)`
   (`semantic-file-ask.ts:779`) without a `realpath`/`isEscapingSymlink` check.
   `readdir` follows a directory symlink base, so `targets: ["linked/**/*.ts"]`
   enumerated `linked/secret.ts` from outside the repo (the read was still
   blocked downstream by `isEscapingSymlink`, but the outside tree was walked).
3. **A candidate silently dropped by the map key.** `buildChoiceRequest`
   (`semantic-file-ask.ts:976`) builds the Choice `criteria` with
   `const criteria: Record<string,string> = {}` and `criteria[candidate.path] = …`.
   Assigning to `__proto__` on a plain object is a no-op, so a root-level file
   named `__proto__` was eligible (`results` included it) yet absent from the
   second-pass options.

The first two are policy bypasses; the third is a silent data loss. All three
are invisible to a test that only exercises the happy path (`.` root, normal
names), which is exactly why they survived to review.

# Context

`semantic_scout` (feature #14) expands a list of files, directories, and globs
into a deduped candidate set, then asks one bounded question per candidate. The
requirements treat directory pruning (`node_modules`, `.git`, `dist`, …) and
"directory symlinks are not followed" as **default policy**, and the review found
the policy holds for discovered children but not for explicitly supplied roots.
Severity in review: M1 (explicit pruned dir) and M4 (glob-base symlink) Moderate,
L6 (`__proto__` key) Low — but they share one root cause class and one fix shape.

Related: [`../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md)
documents the same "policy must not depend on which entry point you came in
through" invariant for the write/edit stage guard, including symlink aliasing as
a residual risk.

# Solution

**Normalize and apply policy once, at every entry into the walker, and again on
every candidate before it becomes an option.**

## 1. Validate the root before walking it

Extract a single `isWalkableRoot(repoRoot, abs)` predicate and call it from
*every* caller of `walkFiles`/`addWalked`, not just from the child loop:

```ts
// One policy, checked at the boundary — not inside the recursive loop only.
async function addWalked(absDir: string, relDir: string, found: Set<string>) {
  if (isPrunedRelative(relDir)) return;                    // explicit pruned dir
  if (await escapesRepoRoot(absDir)) return;               // escaping symlink base
  const collected: string[] = [];
  await walkFiles(absDir, relDir, collected);
  for (const candidate of collected) found.add(candidate);
}
```

Then `addGlobMatches` routes through the same `addWalked` (realpath the glob
base) and `addLiteralTarget` rejects a directory whose first path segment is in
`PRUNED_DIRS`. One predicate, three call sites.

## 2. Treat "is this the root?" as a policy question, not a loop detail

`sortedChildren(dir).filter(...)` inside `walkFiles` answers "may I descend into
this child?" The missing question is "may I start here at all?" Keep the two
checks next to each other so a new entry point cannot be added without reusing
the first.

## 3. Never key a plain object with an untrusted string

Use `Object.create(null)` (or a `Map`) whenever keys come from file paths,
user input, or any external string:

```ts
const criteria: Record<string, string> = Object.create(null);
criteria[candidate.path] = describeAnswer(candidate.answer);
```

`Object.create(null)` has no `Object.prototype`, so `__proto__`, `constructor`,
and `toString` are ordinary own keys. `new Map()` is the clearer choice when the
value is later iterated.

# Why this works

- **The root is just another directory.** Pruning and containment are properties
  of a path, not of how the path was reached. Checking them only during descent
  makes the policy depend on the attacker/caller's chosen entry point.
- **`lstat` tells you what a path is; `realpath` tells you where it points.**
  A walker that decides safety from `lstat`/`isSymbolicLink` on discovered
  entries still hands `readdir` an unvalidated base. Resolving the base through
  the same `isEscapingSymlink` check closes the gap that content-level checks
  cannot (they run too late — after enumeration).
- **`__proto__` assignment is a setter, not a key write.** Any `.`-assignment on
  a plain object for a key named `__proto__` mutates the prototype slot instead
  of creating an entry. The candidate is then absent from iteration while
  `Object.keys`/`in` checks on the object look benign.

# Prevention

- **Ask "may I start here?" separately from "may I descend here?"** for every
  recursive walk, and call the start-check on every entry point (explicit
  target, glob base, root, and any `addWalked`-style helper).
- **Route all walker callers through one guarded helper.** If two functions call
  `walkFiles` directly, one of them will eventually skip the guard.
- **Add an adversarial expansion test per entry point**, not just the root:
  `targets: ["node_modules"]`, `targets: ["<symlink-dir>/**"]`, and a file named
  `__proto__`; assert the candidate is excluded (pruned/unsafe) or present
  (normal) — never silently missing.
- **Prefer `Map` or `Object.create(null)` for externally keyed maps.** Lint or
  review any `const x: Record<string, T> = {}` whose key is a path, name, or ID.
- **Probe with a live temporary repo.** The review found M1/M4 with a temp repo
  (`node_modules/pkg/index.js`, `linked -> /tmp/outside`) in one command; unit
  tests over the happy path did not.

## Downstream Impact

### For 02-plan

- When a unit expands files/dirs/globs into a candidate set, add an explicit
  invariant row: *prune and containment apply to the root/base too*, with the
  per-entry-point test list (root, explicit pruned dir, glob base symlink).
- Budget the walker as one guarded helper (`addWalked`) instead of parallel
  direct `walkFiles` calls; make "all callers go through the guard" part of the
  frozen signature/decision.

### For 04-review

- **Flag any `walkFiles`/`walk`-style call that receives a directory without a
  preceding prune/containment check** — especially glob bases and literal
  directory targets.
- **Flag `Record<string, T> = {}` whose keys are filesystem/user-derived**
  (`__proto__`, `constructor` collisions); require `Map` or `Object.create(null)`.
- Request the adversarial per-entry-point expansion tests; a test that only
  roots at `.` does not exercise M1/M4.

## Related solutions

**Overlap check:** no High-overlap card exists (new artifact, distinct root cause).
Closest existing cards: `deterministic-path-classification-guard-for-stage-scoped-tool-calls`
(Moderate — same entry-point-independent policy invariant, different path class) and
`shadow-first-semantic-ranking-with-deterministic-fallback` (Low — shared `semantic_scout`
safety contract). Created new rather than updated.

- [`../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md`](../workflow/deterministic-path-classification-guard-for-stage-scoped-tool-calls.md)
  — same "policy must be entry-point independent" invariant for write/edit
  classification, plus the symlink-aliasing residual risk this card closes for
  the walker.
- [`../architecture/shadow-first-semantic-ranking-with-deterministic-fallback.md`](./shadow-first-semantic-ranking-with-deterministic-fallback.md)
  — the sibling `semantic_scout`/ranking safety contract; its "one shared entry
  point" rule is the same consolidation this card recommends for the walker.

## Provenance

- **Source review:** `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
  (Findings M1 explicit pruned dir, M4 glob-base symlink, L6 `__proto__` key)
- **Source handoff:** `.context/compound-engineering/handoffs/2026-10-05T21-12-11-357Z-04-review-to-05-learn.md`
- **Requirements:** `docs/brainstorms/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting-requirements.md` (R3 path safety, M3 symlink policy)
- **Plan:** `docs/plans/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting-plan.md` (Unit 4 scouting expansion, Unit 1 path helpers)
- **Source files:**
  - `extensions/ce-core/utils/semantic-file-ask.ts` — `PRUNED_DIRS`, `walkFiles`, `addWalked`, `addGlobMatches`, `expandOneTarget`, `buildChoiceRequest`
  - `extensions/ce-core/utils/repo-paths.ts` — `globBase`, `isEscapingSymlink`, `isInside`, `canonicalRel`
- **Status:** findings deferred to an on-demand `04-5-debug` pass; the feature is new and unreleased, so the defects are live when the tools ship.

## 🧠 Context Status

- **Health:** good — the learning is captured; the three findings are time-boxed
  to an on-demand `04-5-debug` pass before the tools are relied upon.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/architecture/apply-traversal-policy-to-expansion-roots.md`,
  `extensions/ce-core/utils/semantic-file-ask.ts`,
  `extensions/ce-core/utils/repo-paths.ts`,
  `docs/reviews/2026-10-05-jev-cheap-semantic-file-reads-and-repo-scouting.md`
- **Recommendation for `06-docsync`:** carry the "prune/contain at every
  entry point" rule into `CONTEXT.md` semantic-scouting vocabulary and the
  deferred M1/M4/L6 note into the docs sync.
