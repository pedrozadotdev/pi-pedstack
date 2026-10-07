---
name: 03-work
description: "Execute plan units with TDD enforcement and checkpoint resume. Use when a plan path is ready for implementation."
disable-model-invocation: true
---

# Work

Use this skill when there is a plan path or tightly scoped bare prompt ready for execution.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

1. Load project rules (4 steps):
   - Load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/common/development-workflow.md` and `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/common/testing.md`
   - Detect project language via [language detection](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/language-detection.md)
   - Load matching language-specific rules
   - If frontend/browser concerns, also load `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/web/` files
2. **Priority:** project-level `{repo-root}/rules/` overrides package defaults
3. **Distinguish input:** plan path vs bare prompt
4. Derive tasks from plan **implementation units**
5. **Execution mode:** **inline mode** — execute all implementation units sequentially inline. Do not use subagents or parallel delegation.
6. Use **`session_checkpoint`** to track progress and enable resume
7. Use **`task_splitter`** to analyze dependencies before execution
8. End by recommending `04-review`

## Hard gates — TDD enforcement

Every step follows **RED → GREEN → REFACTOR**:

**Blocking violations** — stop and ask if:

- Code written before RED test
- RED fails for wrong reason
- Missing evidence test failed before implementation
- Missing evidence test passed after implementation
- Tests added only after code

## Stop-the-line rule (Hard gate)

When any unexpected failure occurs during execution:

1. **STOP** adding features or making changes
2. **PRESERVE** evidence (error output, repro steps)
3. **DIAGNOSE** root cause — follow debug discipline (`~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/03-work/references/debug-discipline.md`): build feedback loop first, then reproduce → hypothesise → instrument → fix
4. **FIX** the root cause, not the symptom
5. **GUARD** with a regression test
6. **RESUME** only after verification passes

Anti-rationalization — when a gate fails or evidence is missing:

- Do not rationalize, downgrade, or explain away the failure.
- Stop, report the blocker with evidence, and either fix the root cause or ask for direction.
- Do not continue unrelated implementation after failed verification.

This is a hard gate — do not push past a failing test or broken build to continue implementation. Errors compound.

## Error compaction after recovery

After a stop-the-line failure is diagnosed, fixed, and verified:

1. Replace full traces in handoff/context with `ERROR(resolved): <root cause>`
2. Keep only the final repro, root cause, fix summary, and verification result
3. Remove intermediate debug output and failed exploratory runs that are no longer relevant
4. Update `session_checkpoint` with the compacted state only

If the same tool, command, or implementation unit fails 3 consecutive times, stop retrying and ask the user for direction with a concise evidence summary.

## Workflow

1. **Load context**: consume latest handoff before any broad file reads — `context_handoff load` or read `.context/compound-engineering/handoffs/latest.md`. If found, use `activeFiles`, `blocker`, `verification`, `activeRules` as starting point. If not found, proceed normally.
2. **Review-fix re-entry:** if the handoff came from `04-review` and `artifacts.review` is present, enter fix-forward mode before normal plan execution:
   - read the compiled review report first;
   - treat each confirmed `- **Finding**:` entry as the bounded work list;
   - verify the finding against current code before changing anything;
   - fix every confirmed high/moderate/low finding that is still applicable, using RED → GREEN → REFACTOR and targeted regression coverage;
   - do not edit the review report in `03-work`; the next `04-review` run owns re-review and a fresh outcome;
   - after fixes and verification, produce the normal work completion report and hand off to `04-review`.
3. Detect input type (plan path vs bare prompt)
3. Read implementation units if plan path
4. Load `session_checkpoint` to skip completed units
5. Use `task_splitter` for dependency analysis
6. Execute: **inline mode** — run all task groups sequentially inline.
7. Follow TDD per unit: RED → minimal code → GREEN → refactor → unit-level **verification** (applies to inline execution)
8. **Source-driven gate:** Before implementing framework/library-specific code, verify the API or pattern against official documentation using the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/contextqmd-docs.md)). Run `contextqmd libraries list --json` to check for installed docs, install missing libraries via `contextqmd libraries install <library>`, search local docs via `contextqmd docs search`, and retrieve pages using `contextqmd docs get` to confirm usage. Cite key documentation sources in the output, and flag unverified patterns as UNVERIFIED in output. When a docs-verification obligation is open, close it with a `docs-verified: PACKAGE@VERSION DOC_REF` line on the plan unit; a `required`/`uncertain` unit fails the non-critical `source_verification_obligations` check until the obligation is satisfied or waived.
9. Record progress via `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/03-work/references/progress-update-format.md`
10. Save `session_checkpoint` after each unit
11. On failure: `session_checkpoint` `fail` → `retry` → follow strategy
12. Provide completion report (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/03-work/references/completion-report.md`)
13. **Save handoff**: `context_handoff save` with current stage, next stage, activeFiles, blocker, verification, activeRules
14. Handoff to `04-review` using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/03-work/references/handoff.md`

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
