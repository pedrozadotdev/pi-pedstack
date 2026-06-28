---
title: Extracting Optional Pipeline Stages with On-Demand Command Gating
category: workflow
severity: high
tags:
  - pi-extension
  - pipeline-config
  - stage-extraction
  - command-gating
  - staged-discipline
  - ponytail
applies_when:
  - "A pipeline stage is optional and should be removed from the default sequence"
  - "An optional stage needs to be accessible via a dedicated command"
  - "Gating logic is needed with different severity levels (warn vs. block)"
  - "Multiple files must be updated atomically when changing pipeline topology"
  - "A routing-only skill needs to be replaced with a full implementation skill"
---

# Problem

A workflow pipeline has a stage that runs on every cycle but is only useful when certain conditions are met (e.g., bugs were found). Forcing every cycle through this stage creates unnecessary friction — the user must answer "any bugs?" on every run even when the answer is always "no".

At the same time, the stage **must remain accessible on demand** because when it is needed, it is critical. Removing it entirely would lose the capability.

The challenge: how do you remove a stage from the default pipeline without losing the ability to enter it when needed, with appropriate gating based on workflow progress?

# Context

The pi-pedstack pipeline had `04-5-debug` as a mandatory routing stage:

```
01 → 02 → 03 → 04 → 04-5-debug → 05 → 06
```

The debug stage was `disable-model-invocation: true` — it asked the user "any bugs?" and routed to `03-work` (yes) or `05-learn` (no). This forced an extra model invocation and user interaction on every pipeline cycle, even when no bugs existed.

The solution required:

- Removing `04-5-debug` from the default pipeline sequence
- Making it accessible via `/ped-debug` command
- Adding gating: warn if before 04-review, block if no workflow
- Replacing the routing-only SKILL.md with a full 5-phase debug skill
- Updating handoff references, prompt injection disciplines, and AGENTS.md

# Solution

## 1. Change the default pipeline sequence

Update the canonical pipeline sequence in all locations that define it:

```text
# Before (mandatory debug stage)
01-brainstorm → 02-plan → 03-work → 04-review → 04-5-debug → 05-learn → 06-docsync

# After (clean default, debug on demand)
01-brainstorm → 02-plan → 03-work → 04-review → 05-learn → 06-docsync
```

Files that define the sequence: `skills/01-brainstorm/SKILL.md`, `skills/references/pipeline-config.md`, `AGENTS.md`.

## 2. Add a dedicated command with staged gating

Use the existing command factory pattern (`Omit<RegisteredCommand, "name" | "sourceInfo">`) to add the command. Apply staged gating based on workflow position:

```typescript
// Gating logic pattern:
// - No workflow exists → BLOCK (exit code 1, clear error message)
// - Workflow not past 04-review → WARN (output warning but allow with user override)
// - Workflow at 04-review or beyond → ALLOW (no warning needed)
function getGatingVerdict(state: WorkflowState): "block" | "warn" | "allow" {
  if (!state.currentStage) return "block";
  if (state.currentStage === "04-review" ||
      state.currentStage === "05-learn" ||
      state.currentStage === "06-docsync") return "allow";
  if (state.currentStage === "01-brainstorm" ||
      state.currentStage === "02-plan" ||
      state.currentStage === "03-work") return "warn";
  return "allow"; // unknown stage — don't block
}
```

The interface follows the existing command pattern: register in `index.ts`, export from the command module, use `prepareStageNavigation` for session branching.

## 3. Replace routing-only skill with a full skill

Remove `disable-model-invocation: true` from the skill's SKILL.md frontmatter and write a multi-phase skill that provides real value:

1. **Information Gathering** — Check logs, test outputs, error traces; reproduce the error
2. **Root Cause Analysis** — Systematic trace of execution flow; hypothesize and test
3. **Implementation** — Simplest robust fix, no scope creep
4. **Verification** — Confirm fix resolves the bug; rollback assumptions if not
5. **Report** — Root cause, files changed, verification evidence

## 4. Update all downstream references atomically

Every file that references the old pipeline sequence must be updated in lockstep:

- **04-review handoff**: Change next-stage reference from `04-5-debug` to `05-learn`, mention `/ped-debug` as optional
- **Prompt injection disciplines**: Update `STAGE_DISCIPLINES` to map `04-review → 05-learn` and `04-5-debug → 05-learn`; inject Ponytail discipline into debug stage
- **AGENTS.md**: Update pipeline sequence diagram and command table with `/ped-debug`
- **Pipeline config**: Update next-step mapping

## 5. Test all gating paths

Test cases must cover every branch of the gating logic:

| Scenario | Expected |
|----------|----------|
| No workflow directory | Blocked with clear message |
| Workflow at 03-work | Warning shown, allowed on override |
| Workflow at 04-review | Allowed, no warning |
| Workflow at 05-learn | Allowed, no warning |
| Workflow at 06-docsync | Allowed, no warning |
| Empty / whitespace prompt | Allowed (default behavior) |
| Navigation cancelled | Returns without error |
| `switchStageConfig` failure | Error handled gracefully |

# Why this works

## Staged gating respects user autonomy

Blocking when no workflow exists protects the user from an meaningless operation. Warning when the workflow is too early gives the user information while still letting them override. Allowing without warning when past review respects that the user knows what they're doing. This is the **minimum viable friction** principle.

## Command pattern is already established

The project already has `/ped-fix-issues` and `/ped-reload` following the same pattern. Adding `/ped-debug` with the same factory shape means no new architectural concepts — just following existing conventions. This is a Ponytail-aligned approach: use what already exists.

## Atomic updates prevent drift

Updating 5+ files in the same change ensures the pipeline is consistent everywhere. Outdated references in SKILL.md files or AGENTS.md would cause confusion during later stages (04-review would hand off to 04-5-debug which no longer exists in the default flow). Inconsistent state across these files is the most common source of pipeline bugs.

## Routing-only → full skill justification

A routing-only stage that does nothing but ask a yes/no question wastes a model invocation on every cycle. By making it a full skill only entered on demand, the capability is preserved (and even improved — now the skill actually helps debug) while the friction is eliminated for the common case.

# Prevention

## For future pipeline topology changes

1. **Audit all references first.** Before changing a pipeline sequence, search the entire repo for the old sequence string and the stage name. Use `grep -rn "04-5-debug"` or better, `cbm_search_code`. Every reference must be updated.

2. **Test the gating exhaustively.** The command gating is a state machine with 3 outputs × multiple inputs. Test every branch explicitly — missing a case (e.g., what happens if the session tree returns null) will cause a runtime error.

3. **Mark intentional duplication with `ponytail:` comments.** When following an existing pattern requires copying boilerplate (e.g., workflow state reading, stage navigation), add a comment explaining why extraction is not worth it. This signals to reviewers that the duplication was deliberate.

4. **Verify with `bun test` and `fallow_audit`.** The test suite must pass (306 tests in this project). Run `fallow_audit` to catch any introduced complexity or duplication issues, and evaluate each finding against Ponytail discipline before fixing.

5. **Cross-reference with existing solution docs.** Before implementing, check `docs/solutions/` for related learnings. The command factory pattern, pending state injection, and handoff gating all had existing solution artifacts that informed the implementation.

## Search keywords for future retrieval

Use these keywords when searching for this learning in `02-plan` or `04-review`:

- `stage extraction` — to find this artifact when planning pipeline changes
- `command gating` — when adding gating logic to other commands
- `pipeline topology` — when changing the default sequence
- `optional stage` — when considering whether a stage should be mandatory

## Related solutions

- [Replacing Implicit Input Interception with Explicit Commands](../workflow/replacing-implicit-input-interception-with-explicit-commands.md) — command factory pattern used as foundation
- [Before Agent Start Pending State Injection](../workflow/before-agent-start-pending-state-injection.md) — pending state patterns used for prompt injection
- [Tool-Based Task Tracking with Handoff Gating](../workflow/tool-based-task-tracking-with-handoff-gating.md) — gating patterns for handoff flow control
