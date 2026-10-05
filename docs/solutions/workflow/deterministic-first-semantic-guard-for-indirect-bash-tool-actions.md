---
title: Deterministic-First Semantic Guard for Indirect (Bash) Tool Actions
category: workflow
severity: high
tags:
  - pi-extension
  - tool-call-guard
  - stage-guard
  - bash
  - shell-classification
  - deterministic-first
  - jev
  - semantic-fallback
  - fail-open
  - shadow-mode
  - threat-model
  - command-substitution
  - quote-aware-scanner
  - capability-matrix
  - complexity-budget
  - redaction
  - regression-test
  - pedstack
applies_when:
  - Extending a path-based write/edit guard to indirect mutation surfaces (bash, package runners, interpreters)
  - Designing a "deterministic-first, model-on-ambiguity" pipeline where a local classifier owns policy and a model only answers bounded questions
  - Building a shell-effect classifier or any tokenizer that must "prove safe" before allowing
  - Reusing an existing classifier/evaluator across a new guard and inheriting its debt
  - Setting up shadow → enforce rollout with a measurable fail-open (fallback) rate
  - Running a code review where `tsc` and a dead-code analyzer both pass but unused locals remain
---

# Problem

A stage-capability guard that only inspects `write`/`edit` **by target path** is blind to any
stage violation routed through `bash`: `sed -i extensions/foo.ts`, `echo x > extensions/foo.ts`,
`python - <<'PY' …`, `bun run generate`, `npm install <pkg>`. A shell blacklist is always one
wrapper (`bash -c`, heredoc, command substitution) behind, so the guard must reason about the
**semantic effect and intent** of a command, not its spelling.

This card records the reusable lessons from landing that second guard
([source requirements](../../brainstorms/2026-10-05-jev-semantic-stage-guardian-for-indirect-tool-actions-requirements.md),
[source plan](../../plans/2026-10-05-jev-semantic-stage-guardian-for-indirect-tool-actions.md),
[source review](../../reviews/2026-10-05-jev-semantic-stage-guardian-for-indirect-tool-actions.md)).
It is the indirect-surface complement to
[Deterministic Path-Classification Guard for Stage-Scoped Tool Calls](./deterministic-path-classification-guard-for-stage-scoped-tool-calls.md).

# Context

The repo already had a pure path classifier (`classifyPath` → 11 classes), a capability matrix
(`STAGE_CAPABILITIES`), and a thin `pi.on("tool_call")` handler for `write`/`edit`. The new work
adds, for `bash` only:

- `command-effect.ts` — a pure, bounded shell tokenizer + effect classifier (`read_only`,
  `mutates_workspace`, `deletes_or_destructive`, `installs_dependencies`,
  `runs_tests_or_builds`, `package_runner`, `pipe_to_shell`, `container_or_remote`, `ambiguous`),
  extracting literal targets and reusing `evaluateWrite` for the verdict.
- `semantic-stage-guard.ts` — policy + verdict mapping; builds the two bounded Jev questions
  (`effect` Choice, `intent` Noul) and maps answers back under TypeScript confidence thresholds.
- `stage-guard-runtime.ts` — orchestration (dedupe, serialization, degradation notice); no Pi
  imports, all I/O injected.
- `guard-log.ts` — shadow JSONL sink for calibration.

The threat model is explicitly **deterrence against a drifting/careless model, not a sandbox**.
`$VAR`/globs/symlinks, `eval`, `curl | sh`, encodings, and any command the classifier cannot prove
are accepted residual bypasses and are documented as such.

# Solution

## 1. Deterministic-first; the model only fills proven gaps

Classify the command in-process; consult the semantic model **only** for effects the classifier
cannot prove (`ambiguous`, `package_runner`, `pipe_to_shell`, `container_or_remote`, or a
mutating/destructive family with an unresolvable target). Policy, thresholds, and fallback stay in
TypeScript; the model returns bounded signals (an effect label + a yes/no intent), never a verdict.

Why: it keeps the common case (grep/cat/tests) at in-process latency and zero token cost, and it
keeps the guard testable offline. The deterministic plan is also what makes the model call
*cheap* — you send it one already-classified command, not a permission decision.

```ts
const plan = planCommandGuard(stage, repoRoot, command); // pure
const verdict = plan.verdict ?? await decideViaJev(plan); // model only when needed
```

## 2. A deterministic block is final — the model only ever *adds* blocks

When the deterministic pass already blocks (a forbidden literal target), do **not** call the model
and do **not** let it override. Enforce this structurally by returning a `verdict` on the plan and
skipping the model call entirely:

```ts
if (plan.verdict) return plan.verdict;      // deterministic allow OR block
return await decideViaJev(plan);            // only reached when plan.verdict is undefined
```

This is the "optimistic model answer must never weaken a hard gate" invariant, and it is the same
shape as the path guard's `workflow-state`-never-allowed rule: the strongest rule is evaluated
first and is not re-litigated downstream.

## 3. The highest-value bug class: quote-aware scanning asymmetry

The bounded tokenizer flagged `$(`/backtick command substitution only at the top level, while its
`readQuoted` helper consumed double-quoted spans **without** setting the substitution flag. Result:

```text
echo "$(rm -rf extensions)"   -> read_only  / allow / needsJev = false   ❌
echo $(rm -rf extensions)     -> ambiguous  / routed to Jev              ✅
```

Same substitution, two answers — an internal inconsistency and a real bypass. Fix: in the
double-quote branch (only double quotes and backticks permit expansion; single quotes do not),
set `hasSubstitution` on an unescaped `$(` or backtick. ~3 lines plus two regression fixtures.

**General rule:** a scanner that licenses "prove-safe" decisions must flag dynamic expansion in
**every** quote context that permits it. Test the asymmetry directly (`"$(…)"` vs `$(…)` vs
`'$(…)'`) — a happy-path fixture will not catch it.

## 4. Fail-open must be measured, and fail-closed must be an explicit opt-in

Default fallback when the model is unavailable/slow/errors: **allow** (never weaken existing hard
gates). Add an explicit enforce-only kill switch (`FAILCLOSED=1`) that blocks instead, and emit a
one-time "degraded" notice so operators are not surprised. Land in **shadow** mode by default and
only enable enforcement after sampling the **fallback rate** from the shadow JSONL.

```ts
if (options.failClosed && options.mode === "enforce") return { ...base, verdict: "block", reason };
return { ...base, verdict: "allow" }; // default
```

Modes are a small truth table read once (`off | shadow | enforce`); an invalid/absent value fails
safe to `shadow`. Do not create an SLO-enforcement helper until shadow data exists (YAGNI).

## 5. Reusing a classifier imports its debt — fix the shared module first

The new guard reused `classifyPath`/`evaluateWrite`, so the pre-existing `classifyRelative`
ordering gap (invariant class shadowed by basename rules — see the
[path-classification card](./deterministic-path-classification-guard-for-stage-scoped-tool-calls.md) §2)
had to be fixed as a **prerequisite**, and the new classifier added its own complexity findings.
`fallow audit --base HEAD` returned `verdict: fail` with 6 introduced complexity findings
(`classifyRelative` CC17, `scanStep` CC16, `classifyExecCommand` CC12, `classifyManager` CC11,
`readSignals` CC12, `decideDeterministic` CC10).

Lesson: when a new feature shares a classifier, budget the refactor of the shared module into the
plan. The prior card already prescribed an ordered predicate table for `classifyRelative`; skipping
it meant both issues (#3 and #4) carried the finding. If the audit gate is not enforced in CI
(here `.github/workflows/test.yml` runs only `bun test`), record the failing verdict explicitly as
an accepted deviation — never silently drop it.

## 6. Verify with three tools, not one — each has a blind spot

`bun test` (621 pass) and `tsc --noEmit` (exit 0) both passed, and the dead-code analyzer reported
no unused exports, yet **two real TS6133 defects shipped**: an unused `stage` parameter in
`jevBlock` and an unused `JevChoiceQuestion` import. `tsc` missed them because
`noUnusedLocals`/`noUnusedParameters` are off; the analyzer missed them because they are not
exports. Only the LSP probe on the changed modules caught them.

Run all three: `bun test` + `tsc` + an LSP/`lens_diagnostics` probe of changed files. Then close the
class of defect by enabling `noUnusedLocals`/`noUnusedParameters`, not just by fixing the two
lines.

## 7. Redact before logging or asking; cap the excerpt

The model request carries a **redacted, truncated** command (`redactCommand` then
`truncateCommand(…, JEV_COMMAND_STATE_MAX_CHARS)` + marker) and the raw command is never persisted
to the shadow JSONL. Redaction masks env assignments and quoted literals; unquoted credentials
(`curl -u user:pass`, `--token=…`) remain a documented residual. A frozen export
(`MESSAGE_COMMAND_MAX_CHARS`) that only tests consume is a smell — either use it in the block
message template or delete it (unused constants survive review easily).

## 8. Serialize and dedupe model calls keyed by stage+repo+command

One in-flight decision at a time (`jevChain`) and a bounded memo cache (`DEDUPE_CACHE_MAX` LRU)
keyed by `stage\0repoRoot\0command`. Concurrent identical commands share one promise; distinct
commands queue. This bounds cost/latency under a burst of ambiguous commands and makes the guard
deterministic under repetition.

# Why this works

- **Deterministic-first makes the model optional, not load-bearing.** If the semantic layer is
  absent, hard gates still work; the model can only ever tighten the policy.
- **A block that can be overridden is not a gate.** Returning `plan.verdict` before any model call
  turns "optimistic answer can't weaken a block" from a promise into a control-flow fact.
- **The scanner is where "prove safe" lives, so its blind spots are bypasses.** The quoted/unquoted
  asymmetry shows that a tokenizer's quote handling is security-relevant, not cosmetic.
- **Deterrence framing keeps the design honest.** Documenting residual bypasses prevents the
  false comfort of a "sandbox" claim and focuses effort on the common accidental case.

# Prevention

- When extending a guard to a new surface, write the **threat model and accepted bypasses first**;
  a guard that claims totality is either wrong or unreadable.
- For any "prove-safe" scanner, enumerate quote contexts as test fixtures (`"$(…)"`, `` `…` ``,
  `'$(…)'`, escaped) and assert the conservative branch for each.
- Put the strongest invariant **first** and short-circuit it (no model, no re-evaluation) — mirror
  the path guard's `workflow-state`-first rule.
- When reusing a shared classifier, add its refactor to the plan scope; do not assume the new
  consumer is isolated from its debt.
- Record the **top-line** `fallow audit`/gate verdict in the handoff, not a passing subset. A
  handoff line like "0 dead exports / 22 duplicated lines" is misleading when the actual verdict
  is `fail`.
- Run `bun test` + `tsc` + an LSP probe on changed files before review, and enable unused-symbol
  checks in the compiler so TS6133 cannot ship.
- Verify that required tooling actually produces artifacts: `multi_reviewer` returned
  "No result provided" and persisted no findings JSON, so have a fallback plan for when the
  reviewer tool is unavailable.

# How future stages should use this

- **`02-plan`**: apply the deterministic-first / model-on-ambiguity split to any "smart guard"
  task; budget the shared-classifier refactor; enumerate the accepted-bypass list as an explicit
  section; check the three-tool verification gap against the plan's success criteria.
  Search `docs/solutions/` with `tags:.*tool-call-guard`, `tags:.*deterministic-first`,
  `applies_when:.*indirect`.
- **`04-review`**: treat quote-handling and dynamic-expansion paths as the first place to look for
  a false-allow; confirm the deterministic block short-circuits before any model call; run the LSP
  probe because `tsc`+dead-code alone miss unused locals; read the gate verdict top line.
