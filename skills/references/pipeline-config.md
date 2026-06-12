# Shared pipeline instructions

Use these rules in all pipeline skills: `01-brainstorm` → `02-plan` → `03-work` → `04-review` → `04-5-debug` → `05-learn` → `06-docsync`.

## Start of skill: model routing

Model routing and thinking level switching are handled automatically by the ce-core extension. When a pipeline stage skill is invoked, the extension automatically sets the appropriate model and thinking level.

No manual `/model` or `/thinking` command is needed. The skill itself does not need to handle model switching.

## Start of skill: context loading

Before reading any project files or running repository-wide scans, load the most recent handoff:

1. Try `context_handoff load` or `context_handoff latest` first.
2. Fallback: `read .context/compound-engineering/handoffs/latest.md` if tool is unavailable.
3. **Handoff found?** Consume its `activeFiles`, `blocker`, `verification`, `currentTruth`, `activeRules` before any broad project reads.
4. **No handoff?** Proceed normally — this is a new project or first run. Do not block.

Core principle: **consume handoff before broad project file reads** — a single handoff read (~500 tokens) avoids 5-10 project file scans (~5K-10K tokens).

## Context hygiene rules

Applies to all skills when preparing context or saving handoff.

1. **Compact resolved errors** — Once an error is diagnosed, fixed, and verified, do not carry the full trace forward. Replace it with `ERROR(resolved): <root cause>` and keep repro/verification only if still relevant.
2. **Fetch obvious prerequisites** — If the next step has an obvious deterministic prerequisite, fetch it before reasoning further instead of spending an LLM round trip asking for it.
3. **Cap repeated failures** — After 3 consecutive failures on the same tool, command, or implementation unit, stop retrying. Summarize evidence and ask the user for direction.
4. **Prune before handoff** — Before saving handoff, keep only what the next stage needs. Move broad history to artifact paths; remove intermediate debug output that is no longer relevant.

## End of skill: save handoff + status + context

Every pipeline skill (02-plan through 06-docsync) must save context handoff at completion:

```
context_handoff save
  currentStage: <stageKey>
  nextStage: <next stage>
  contextHealth: good | watch | heavy | critical
  activeFiles: [1-5 currently active paths]
  blocker: <blocker or N/A>
  verification: <latest command + result>
  activeRules: [1-5 rules critical for continuation]
  currentTruth: [validated truths]
```

If `context_handoff` is unavailable, manually write the Handoff-lite template to `.context/compound-engineering/handoffs/latest.md`.

Before final completion, always output these blocks (replace placeholders with real values, never output angle-bracket placeholders literally):

```
---
📊 Pipeline Status
- Current: <stageKey>
- Output: <main artifact path or N/A>
- Next: <next skill command or Completed>
---

🧠 Context Status
- Health: good | watch | heavy | critical
- Handoff: <path or N/A>
- Active: <1-5 active files or N/A>
- New session: recommended | not needed
---
```

Next step mapping:
- `01-brainstorm` → `/skill:02-plan`
- `02-plan` → `/skill:03-work`
- `03-work` → `/skill:04-review`
- `04-review` → `/skill:04-5-debug`
- `04-5-debug` → `/skill:05-learn`
- `05-learn` → `/skill:06-docsync`
- `06-docsync` → `Completed`

### Handoff-lite template

When a stage produces or updates handoff-lite, use this evidence-first structure and keep it concise (target <= 1500 tokens):

```md
## Current Task

## Hot Context
- 1-5 must-know facts for the next step

## Current Truth
- validated truths that must survive compression

## Verified Facts
- already validated facts (do not re-prove)

## Invalidated Assumptions
- assumptions proven wrong this session

## Open Decisions
- pending decisions that affect next steps

## Active Files
- 1-5 file paths only

## Recently Accessed Files
- files recently read or edited

## Artifacts
- requirements: <path or N/A>
- plan: <path or N/A>
- review: <path or N/A>
- checkpoint: <path or N/A>
- proof: <path or N/A>

## Current Blocker
- <blocker or N/A>

## Verification
- <latest command + result or Not run>

## Compression Risk
- context compression risks to watch for

## Do Not Repeat
- what should not be re-read/re-run unless needed

## Next Minimal Step
- exact next command/action
```

Rules:
- Use `N/A` instead of inventing facts.
- Keep broad history in artifact paths, not expanded narrative.
- If `context_handoff` is unavailable, manually write this shape to `.context/compound-engineering/handoffs/latest.md` and mention the path.

### New-session recommendation rule

Recommend a new session only when both are true:

1. Phase is changing (`Current` != next stage)
2. Context health is `heavy` or `critical`

When recommending a new session, include a directly copyable prompt:

```md
## Suggest New Session

Reason: Current `<current stage>` is completed, and we are entering `<next stage>`. The current window has a lot of completed stage context, continuing will lower the token ROI and increase the risk of stale context interfering with subsequent judgment.

Recommendation: Open a new window and copy-paste the prompt below to continue.

```text
Continue this pi-pedstack workflow, do not restart.

Repo: <repo path>

Please read first:
- <latest plan/requirements artifact>
- <latest handoff-lite path>
- <latest checkpoint path or summary>

Then continue:
- Run <next skill command>

Context Strategy:
- hot: keep only files necessary for current execution (1-5)
- warm: read back as needed using artifact path
- cold: do not load into current window unless explicitly needed

Core principles:
- Do not repeat completed stages
- Prioritize verifying current stage output
- Control tokens to maintain high ROI
```
```
