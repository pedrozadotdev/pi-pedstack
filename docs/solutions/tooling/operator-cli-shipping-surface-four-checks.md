---
title: A New Operator CLI Has Four Independent Shipping Surfaces — Arg Value, Toolchain Pin, Package Files, Guard String
category: tooling
severity: medium
tags:
  - pedstack
  - cli
  - operator-tool
  - argument-parsing
  - dry-run
  - write-flag
  - toolchain-pinning
  - typescript
  - packaging
  - npm-files
  - ci-determinism
  - guard-test
applies_when:
  - Adding a `scripts/*.ts` CLI (or a `bun run <name>` entry) to a published package
  - The CLI has a destructive `--write` / `--apply` mode and a value-taking flag like `--config <path>`
  - CI or a `typecheck` script invokes a compiler via `bun x` / `npx` with no local dependency
  - A published `package.json` `scripts` entry executes a file that must be shipped
  - Reviewing a diff that adds a CLI, a script entry, and/or a CI step
  - A guard test asserts an exact command string
---

# Problem

Adding one small operator CLI (`scripts/migrate-roles.ts`) plus its `package.json`
entry and a CI type-check step turned out to touch **four independent surfaces that
can each fail silently**, and the `04-review` audits found a defect on every one.

**1. A value-taking flag with a missing value silently retargets the write.**

```typescript
// scripts/migrate-roles.ts:75-77
const configIndex = argv.indexOf("--config");
const explicit = configIndex >= 0 ? argv[configIndex + 1] : undefined;
const configPath = resolveConfigPath(explicit);
```

`--config` as the last argument (or `--config ""`) makes `explicit` `undefined`, so
`resolveConfigPath` (`:17-18`) falls through to the project config, then the global
`~/.pi/pi-pedstack/config.json`. Reproduced with `HOME=/tmp/fakehome`:
`bun scripts/migrate-roles.ts --write --config` exited 0, printed a diff, and
**rewrote the fallback config** the operator never named. A malformed invocation
became a destructive write to the wrong file.

**2. The compiler was resolved over the network, not from the repo.**

`.github/workflows/test.yml:18` ran `bun x tsc --noEmit`, and
`package.json:35` mirrored it (`"typecheck": "bun x tsc --noEmit"`), but
`typescript` was absent from `devDependencies` and the lockfile. `bun x` therefore
downloads the latest compiler on every run: CI can turn red (or green) with no repo
change, and the job now depends on npm network access. The plan had specified the
pinned `"tsc --noEmit"`; the deviation was silently adopted.

**3. The published package omitted the directory its published script runs.**

```json
"files": ["skills","extensions","rules","README.md","package.json"],  // no "scripts"
"migrate:roles": "bun scripts/migrate-roles.ts"                        // runs scripts/
```

`extensions/ce-core/utils/role-migration.ts` was published, but the CLI wrapper was
not, so `bun run migrate:roles` fails with `ENOENT` for any consumer of the npm
package.

**4. The guard test locked in the unpinned defect.**

```typescript
// tests/ci-typecheck.test.ts:14,21
expect(read(".github/workflows/test.yml")).toContain("bun x tsc --noEmit");
expect(pkg.scripts?.typecheck).toBe("bun x tsc --noEmit");
```

The plan's guard was written against the *capability* (`tsc --noEmit`); the shipped
test asserts the exact deviating string, so the correct fix (surface 2) would make
the guard fail. An exact-string guard turned a defect into a requirement.

Each surface is verified by a different mechanism (runtime argv, CI environment,
`npm pack` contents, the test itself), which is why "the tests pass" says nothing
about any of them.

# Context

From the `04-review` findings **M2, M3, M4** and low finding **L2** of the model-role
routing + conditional-review close-out
(`docs/reviews/2026-10-06-model-routing-conditional-review-closeout.md`), covering
plan Unit 8 (the migration CLI) and Unit 1 (restore the type-check/CI floor). The
CLI is small and the suite was green (1731 pass, `tsc` clean), so none of these
would ever have failed a test — they are properties of the *shipping surface*, not
of the code paths the tests exercise.

The through-line: a CLI is not just the function it calls. It is an argv contract, a
toolchain contract, a package-contents contract, and a guard contract, and each one
defaults to a plausible-but-wrong behavior when unverified.

# Solution

Add four cheap checks to any new CLI + script entry + CI step.

1. **Require the value of every value-taking flag; never fall through on absence.**
   Distinguish "flag absent" from "flag present with no value":

   ```typescript
   const configIndex = argv.indexOf("--config");
   if (configIndex >= 0) {
     const value = argv[configIndex + 1];
     if (!value || value.startsWith("--")) {
       console.error("[migrate:roles] --config requires a path");
       return 2; // no write
     }
   }
   ```

   The rule for a destructive CLI: an unparseable invocation must never resolve to a
   default target — it must exit non-zero without writing.

2. **Pin the compiler as a devDependency and invoke the local binary.** Add
   `typescript` to `devDependencies` (lockfile committed), then use
   `"typecheck": "tsc --noEmit"` and the same in CI. `bun x` / `npx` without a local
   install is a network dependency, not a toolchain.

3. **Ship every path a published script executes — or de-scope the script.** If
   `files[]` omits `scripts/`, either add `"scripts"` or remove `migrate:roles` from
   the published `scripts` block and document it as repo-only. Verify with
   `npm pack --dry-run` / `bun pm pack` contents, not by reading `files[]`.

4. **Assert the capability in the guard, not the literal command.** Use a regex that
   accepts the correct form and rejects a missing step:

   ```typescript
   expect(read(".github/workflows/test.yml")).toMatch(/tsc --noEmit/);
   expect(pkg.scripts?.typecheck).toMatch(/tsc --noEmit/);
   // plus: expect(pkg.devDependencies?.typescript).toBeDefined()
   ```

   A guard written from the current (possibly wrong) string forecloses the fix.

# Why this works

- **`argv[indexOf(flag) + 1]` cannot distinguish absent from empty.** The idiom is
  safe for boolean flags and wrong for value flags; the fallthrough then hands the
  operator's destructive command a default target.
- **`bun x` / `npx` mean "resolve if not installed".** Pinning is the only way for a
  type-check gate to be a verdict about *this* repo rather than about today's npm
  registry.
- **`files[]` and `scripts` are two halves of one contract.** A published script that
  runs an unpublished file is only discoverable by packing the tarball; the repo
  checkout always has the file.
- **An exact-string guard is a snapshot of current behavior, not of intent.** When
  the string is itself the defect, the guard becomes an obstacle and quietly shifts
  the "correct" state to match the bug.

# Prevention

- **Checklist for a destructive CLI:** (a) does every value-taking flag error on a
  missing value? (b) does `--write` require an explicitly resolved target? (c) is
  the tool reproducible with `--help` / dry-run before any write?
- **Checklist for adding a CI/tooling step:** (a) is the tool a committed
  devDependency? (b) does the command resolve locally, offline? (c) if a new
  directory is now executed, is it in `files[]`?
- **Verify packaging by packing.** Run `npm pack --dry-run` (or `bun pm pack`) after
  touching `files[]`/`scripts`; grep the file list for every path a shipped script
  invokes.
- **Write guards against capabilities.** If the plan says "assert `tsc --noEmit`",
  assert `/tsc --noEmit/`, not the exact string you happened to ship.
- **In review, treat a new CLI as a four-surface change.** A green suite is not
  evidence about argv edge cases, CI determinism, tarball contents, or guard intent.

## Downstream Impact

### For 02-plan

- When a unit adds a CLI, list its argv contract explicitly (including value flags
  and missing-value behavior) and require a test for the missing-value case.
- When a unit adds a CI step or a `typecheck` script, require the compiler to be a
  pinned devDependency in the same unit — an unpinned `bun x` step is an incomplete
  unit.
- When a unit adds a `scripts` entry to a published package, list `files[]` beside it
  and state whether the target is published.

### For 04-review

- For a new CLI: review argv parsing as a contract (does absence equal default?),
  then check the toolchain pin, then `files[]`, then the guard assertion. These are
  four separate checks and none of them is covered by the unit tests.
- `--config`-style silent fallback on a destructive command is a **moderate+**
  correctness finding, not a style note: it can mutate a file the operator did not
  name.

## Related solutions

- [`../testing/green-test-runner-is-not-a-type-check.md`](../testing/green-test-runner-is-not-a-type-check.md)
  — established the CI type-check step; this card adds the pinning requirement that
  makes the step a verdict about the repo.
- [`../architecture/lossless-config-migration-must-key-on-every-preserved-field.md`](../architecture/lossless-config-migration-must-key-on-every-preserved-field.md)
  — the semantic defect in the same migration helper; this card is the shipping
  surface around it.
- [`./fallow-findings-for-inert-module-barrel.md`](./fallow-findings-for-inert-module-barrel.md)
  — same review family: a local quality signal is only meaningful once you know what
  the gate/tooling actually enforces.

## Provenance

- **Source review:** `docs/reviews/2026-10-06-model-routing-conditional-review-closeout.md`
  (findings M2, M3, M4, L2; reviewers: correctness, integration, thoroughness, testing).
- **Source plan:** `docs/plans/2026-10-06-model-routing-conditional-review-closeout-plan.md`
  (Unit 1 / G5, Unit 8 / G6).
- **Source files:** `scripts/migrate-roles.ts` (`:17-18`, `:75-77`),
  `.github/workflows/test.yml` (`:18`), `package.json` (`:23-30`, `:35-36`),
  `tests/ci-typecheck.test.ts` (`:13-21`).
- **Reproduce:** `HOME=/tmp/fakehome bun scripts/migrate-roles.ts --write --config`
  → exit 0 and a rewritten fallback config; `npm pack --dry-run` → no `scripts/`.
- **Status:** defects confirmed at capture; fixes need dependency/scope decisions and
  are deferred to a `04-5-debug` / `03-work` re-entry because `04-review` and
  `05-learn` must not modify code.
- **Out of scope (recorded, not fixed):** the stale installed skill clone at
  `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/` makes the
  conditional-review fix inert in the live pipeline; that is a distribution/publish
  concern routed to `06-docsync`/release, not a repo change.

## 🧠 Context Status

- **Health:** good — all four surfaces captured with reproductions; no source code
  changed in this stage.
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:** `docs/solutions/tooling/operator-cli-shipping-surface-four-checks.md`,
  `scripts/migrate-roles.ts`, `.github/workflows/test.yml`, `package.json`,
  `tests/ci-typecheck.test.ts`
- **Recommendation for `06-docsync`:** note in `README.md` that the shipped
  `scripts/` CLI is either published with the package or documented as repo-only,
  and that the typecheck command must resolve from `devDependencies`.
