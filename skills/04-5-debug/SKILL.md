---
name: 04-5-debug
description: "Route based on user testing: if bugs found, return to 03-work; if clean, continue to 05-learn."
disable-model-invocation: true
---

# Debug Route

Use this skill after `04-review` has completed. This is a routing-only step to evaluate user testing.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

1. **Load context**: Check latest handoff from `04-review`.
2. **Present summary**: Show a concise list of implemented features and review findings to the user.
3. **Prompt the user**: Ask the user directly if they found any bugs during manual verification or testing.
4. **Task Tracking:** Before initiating the work in this stage, register your micro-tasks using `todo_add`. Continually check your list using `todo_list` and mark items complete with `todo_done`. **CRITICAL:** You must not execute `context_handoff` to the next stage if there are pending tasks on your list.
   - **Bugs found**: Stop execution, prompt the user for bug reports, and recommend running `/ped-next` to return to `03-work`.
   - **Clean / No bugs**: Recommend running `/ped-next` to proceed to `05-learn`.

## Exit Criteria

- Next step recommended clearly based on user response.
