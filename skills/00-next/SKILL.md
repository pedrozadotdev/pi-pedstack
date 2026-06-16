---
name: 00-next
description: "Inspect workflow artifacts and recommend the single best next skill. Use when unsure what to run next."
disable-model-invocation: true
---

# Next

Use this skill when the user wants to know what to run next in the Compound Engineering workflow, or wants a full status report of the current project state.

## Core rules

- Use **`workflow_state`** tool to scan repo artifacts before making a recommendation.
- Use **`session_history`** tool to check recent executions and avoid already-completed steps.
- Recommend exactly **one** next skill with a clear reason.
- Do not execute the recommended skill — only suggest it.
- If multiple valid paths exist, pick the one closest to completing a full loop.

## Two modes

### Default mode: "what's next?"

When the user asks "what should I do next?", "continue", or runs `/skill:00-next`:

1. Call `workflow_state` with the repo root
2. Inspect `workflow_state.context` first — apply **context-first priority chain** from `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/00-next/references/recommendation-logic.md` (health → blocker → recommendNewSession → nextStage → mismatch → fallback)
3. If no context signals trigger, fall back to artifact-count rules
4. Return: skill name, reason (1-2 lines), brief workflow state summary

### Verbose mode: "full status"

When the user asks "show status", "what's the current state", or uses `--verbose`:

1. Call `workflow_state` with the repo root
2. Call `session_history` with `latest` operation
3. Include context health assessment from `workflow_state.context` in the status report
4. Return: latest artifacts (path + summary), status of each phase, context health, recommended next step

## Artifact locations

See `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/00-next/references/recommendation-logic.md` for full recommendation rules and skill list.

**Quick reference:**

| Artifact | Path |
|---|---|
| Brainstorm | `docs/brainstorms/` |
| Plan | `docs/plans/` |
| Review | `docs/reviews/` |
| Solution | `docs/solutions/` |
| Runtime | `.context/compound-engineering/` |

**Available skills:** `01-brainstorm`, `02-plan`, `03-work`, `04-review`, `04-5-debug`, `05-learn`, `06-docsync`

**Fallback:** If `workflow_state` is unavailable, use `bash ls/find` to check directories, then `read` recent artifacts.

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
