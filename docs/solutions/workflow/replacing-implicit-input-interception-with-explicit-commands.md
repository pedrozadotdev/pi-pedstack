---
title: Replacing Implicit pi.on("input") Interception with Explicit / Commands
category: workflow
severity: medium
tags:
  - pi-extension
  - command-pattern
  - session-branching
  - stage-resolution
  - clean-branching
  - pedstack
  - pi-on-input
  - registerCommand
  - navigateTree
  - discriminated-union
  - followUp
  - extension-api
applies_when:
  - Creating or refactoring a pi extension that intercepts user input
  - Registering custom slash commands via pi.registerCommand()
  - Navigating session trees for clean context branching
  - Building workflow orchestration layers on top of pi skills
---

# Problem

Pi extensions often use `pi.on("input")` to intercept user input and inject side effects — switching models, changing thinking levels, loading context — before skill expansion. This approach has three problems:

1. **Magic**: The user types `/skill:02-plan` but gets model switches, thinking level changes, and context injection as invisible side effects.
2. **Fragile**: Every input event fires the hook, requiring explicit guards for streaming steers (`streamingBehavior === "steer"`), extension-sourced messages (`event.source === "extension"`), and idle state checks.
3. **Inflexible**: There is no way to kick off the first workflow stage (`01-brainstorm`) with a user prompt — the workflow relies on manually typing `/skill:01-brainstorm`.

# Context

This pattern was discovered during the `pi-pedstack` ce-core extension refactor (see [source handoff](../../.context/compound-engineering/handoffs/2026-06-14T15-53-45-525Z-04-5-debug-to-05-learn.md)). The extension previously used `pi.on("input")` to intercept `/skill:*` messages and switch models/thinking levels per stage config. The [`pi-supergsd`](../../pi-supergsd/src/index.ts) codebase demonstrated an alternative: explicit slash commands that use `ExtensionCommandContext` for session tree navigation (`ctx.navigateTree`, `ctx.waitForIdle`) and `ExtensionAPI` methods for message sending and state tracking (`pi.sendUserMessage`, `pi.appendEntry`).

The key insights came from analyzing `pi-supergsd/src/index.ts`:
- `findFreshTargetId()` + `ctx.navigateTree(freshTargetId, { summarize: false })` for clean branching
- `pi.appendEntry("task-start", { returnTo: departureLeafId })` for tracking branch transitions
- Command factories returning `Omit<RegisteredCommand, "name" | "sourceInfo">`

# Solution

Replace `pi.on("input")` with two explicit commands registered via `pi.registerCommand()`:

## 1. Command factory pattern

```typescript
export function cmdMyCommand(pi: ExtensionAPI): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Description shown in /help",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle()  // Wait for streaming to finish
      // ... handler logic using pi.* and ctx.*
    },
  }
}
```

## 2. Clean branching via session tree traversal

```typescript
function findFreshTargetId(session: ReadonlySessionLike): string | null {
  const branch = session.getBranch()
  if (branch.length === 0) return null
  const firstVisible = findPreConversationEntry(session)  // first message/compaction/branch_summary/custom_message
  if (firstVisible) return firstVisible.parentId ?? firstVisible.id
  return branch[0].parentId ?? branch[0].id
}

// Later in the command handler:
const departureLeafId = ctx.sessionManager.getLeafId()  // CAPTURE BEFORE navigateTree!
const freshTargetId = findFreshTargetId(ctx.sessionManager)
const navResult = await ctx.navigateTree(freshTargetId, { summarize: false })
if (navResult.cancelled) return
pi.appendEntry("my-entry-type", { returnTo: departureLeafId })
```

**Critical sequencing rule:** `departureLeafId` must be captured BEFORE `navigateTree()` — navigation invalidates the current leaf.

## 3. Stage resolution with discriminated unions

For auto-resolving next workflow stages:

```typescript
type StageResolution =
  | { ok: true; stage: PipelineStageKey }
  | { ok: false; reason: "critical_health" | "blocker" | "new_session_recommended" | "ambiguous"; details?: any }
```

This lets the handler differentiate abort reasons (critical health → save handoff, blocker → show blocker message, ambiguous → ask user) instead of collapsing all failures to null.

## 4. Safe optional prompt handling

Never concatenate user-provided text into a `/skill:` command string. Instead, include the optional prompt in the skill invocation:

```typescript
const skillMessage = optionalPrompt
    ? "/skill:" + stageKey + " " + optionalPrompt
    : "/skill:" + stageKey;
pi.sendUserMessage(skillMessage);
```

Pi's native command processing treats text after `/skill:name` as user input content, so the prompt becomes part of the skill invocation context.

## 5. Avoid circular imports

When a command module imports from `index.ts` AND `index.ts` imports from the command module, extract shared utilities (like `parseModelRef`) into a separate utils file that both can import.

# Why this works

- **Explicit > implicit**: Commands are visible in `/help`, have descriptions, and don't trigger on every input event.
- **ExtensionCommandContext provides the right API**: `navigateTree`, `waitForIdle`, `sessionManager` are only available in command handlers — these methods are not exposed on `ExtensionContext` (the event handler context). See `@earendil-works/pi-coding-agent` type definitions at `dist/core/extensions/types.d.ts` L246-287 for `ExtensionCommandContext` vs L204-237 for `ExtensionContext`.
- **Discriminated unions make error handling testable**: Each abort reason is a distinct type the handler can match on.
- **Clean branching prevents context pollution**: Each stage starts from the root context, avoiding cross-stage bleed.

# Prevention

- Always register commands via `pi.registerCommand("name", factory(pi))` rather than using `pi.on("input")` for skill interception.
- Follow the `(pi: ExtensionAPI) => Omit<RegisteredCommand, "name" | "sourceInfo">` factory pattern.
- Use discriminated union return types (not `null`) for functions that can fail for multiple reasons.
- Capture `leafId` BEFORE any `navigateTree` call.
- Send user-provided optional prompts appended to the `/skill:name` command, not as separate messages — Pi handles text after the skill name as user input.
- Keep functions under 50 lines and files under 800 lines (per `AGENTS.md` Code Style). Extract helpers like `prepareStageNavigation(ctx)`, `handleResolutionAbort(ctx, resolution)`, `switchModel(pi, ctx, stageKey, config)`.
- Add TSDoc comments to all exported APIs (functions, types, interfaces).
- Use explicit error handling (`formatError(err)` to avoid leaking stack traces).

## Downstream Impact

### For 02-plan

When planning new pi extension features, grep for `tags: pi-extension` or `tags: registerCommand` or `tags: navigateTree` in `docs/solutions/` to find this card. Use the `prepareStageNavigation` and `handleResolutionAbort` patterns as reusable implementation units.

### For 04-review

When reviewing PRs touching pi extensions, flag any new `pi.on("input")` registrations that intercept skill commands — prefer `pi.registerCommand()` with the factory pattern described here.

## Provenance

- **Source handoff:** `.context/compound-engineering/handoffs/2026-06-14T15-53-45-525Z-04-5-debug-to-05-learn.md`
- **Upstream inspiration:** `pi-supergsd/src/index.ts` (clean branching, appendEntry patterns)
- **Workflow loop:** 01-brainstorm → 02-plan → 03-work → 04-review → 04-5-debug → 05-learn

---

## 🧠 Context Status

- **Health:** good
- **Handoff:** `.context/compound-engineering/handoffs/latest.md`
- **Active files:**
  1. `extensions/ce-core/commands/pedstack.ts`
  2. `extensions/ce-core/index.ts`
  3. `extensions/ce-core/utils/parse-model-ref.ts`
  4. `tests/ce-core-extension.test.ts`
- **Next stage:** `06-docsync` — recommend syncing documentation
