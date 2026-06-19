---
title: Bulk API Design for Model-Facing Tools in Pi Extensions
category: workflow
severity: medium
tags:
  - pi-extension
  - api-design
  - checklist
  - bulk-api
  - tool-ergonomics
  - pedstack
  - task-tracking
  - model-facing
  - pipeline-discipline
applies_when:
  - Designing tool APIs that the AI model calls frequently
  - The model typically discovers 5-10+ tasks at once from a single document read
  - Reducing sequential tool calls in a pipeline workflow
  - Designing tools that should batch operations to save model context tokens
  - Reviewing tool APIs for ergonomic efficiency in multi-item operations
---

# Problem

When the AI model reads an instructional document (SKILL.md, rules file, or references file), it typically discovers 5-10 tasks it must perform. If the task-tracking tool accepts only a single item per call, the model must make 5-10 sequential tool calls instead of one. This wastes context tokens, increases latency, and makes the workflow feel tedious.

The original `checklist_add` tool accepted `{ description: string }` — a single task description per call. After real usage in the 04-5-debug cycle, this was identified as an ergonomic bottleneck.

# Context

The pi-pedstack Checklist Tools feature introduced `checklist_add` as a single-item tool:

```typescript
// Original API: single-item
execute({ description: string }): { index: number; description: string }
```

During the 04-5-debug cycle, analysis of real usage patterns showed that the model almost always calls `checklist_add` immediately after reading a SKILL.md or rules file — and those files contain multiple distinct tasks.

The fix: change the API to accept an array of descriptions:

```typescript
// Updated API: bulk
execute({ descriptions: string[] }): { items: Array<{ index: number; description: string }> }
```

*Related solution:* [Tool-Based Task Tracking with Handoff Gating](./tool-based-task-tracking-with-handoff-gating.md) documents the overall Checklist Tools architecture.

# Solution

## Design principle: batch what the model naturally discovers in bulk

When designing a model-facing tool, identify the granularity at which the model discovers work items:

- **If the model encounters items one at a time** → single-item API (`checklist_del` takes `indexes[]` but deletion is a conscious decision per item)
- **If the model encounters items in batches** → bulk API (`checklist_add` takes `descriptions[]` because reading a doc reveals N tasks at once)

```typescript
// ✅ BULK: Add many tasks discovered from one document read
checklist_add({
  descriptions: [
    "Create checklist.ts with factory functions",
    "Add TypeBox schemas in index.ts",
    "Wire handoff gating in context-handoff.ts",
    "Add instructional directive in read-output-filter.ts",
    "Update test for checklist blocking behavior",
  ]
})
// Returns: { items: [{ index: 1, description: "..." }, ...] }
```

## Return structure matches input batch

The return type mirrors the input batch — an array of `{ index, description }` pairs so the model can immediately reference items by index without a separate `checklist_show` call:

```typescript
// Input → Output correspondence
{ descriptions: ["A", "B"] } → { items: [{ index: 1, description: "A" },
                                         { index: 2, description: "B" }] }
```

## Tool description communicates the batching semantics

The tool's `description` field in the registration should tell the model it can batch:

```typescript
// Tool description:
"Add one or more tasks to the checklist in a single call. " +
"Use this when discovering tasks from skills, rules, or instructions."
```

This is critical — if the description says "Add a task" (singular), most models will call it one-at-a-time even though the underlying API supports batching.

# Why this works

1. **Context token efficiency**: One tool call with 10 descriptions uses ~200 tokens; 10 sequential calls use ~2000+ tokens (overhead of tool call/response framing).
2. **Atomicity**: If the model discovers 10 tasks from one file read, a single bulk call is conceptually atomic — either all 10 are recorded or none (if the call fails).
3. **Immediate indexing**: The return includes the 1-based index for each item, so the model can reference items immediately without a follow-up `checklist_show`.
4. **Natural mapping to discovery**: The model reads one document, discovers N tasks, makes one call. The API matches the mental model.

# Prevention

- **Analyze discovery patterns before finalizing tool APIs**: If the tool is for tasks the model discovers in groups, design it as bulk from the start.
- **Write the tool description to match the bulk semantics**: The description is how the model learns the API — use "Add one or more", not "Add a".
- **Return per-item metadata (index) in the batch response**: Otherwise the model must make a second call to learn the indexes.
- **During code review, flag any tool that returns a single result for a plural operation**: If the input is `items[]` but the output is a single `{ id }`, the model can't efficiently reference individual items.
- **Test the bulk path**: Add tests for adding 0 items, 1 item, 10 items, and verify the returned `items` array has correct indexes.

## Downstream Impact

### For 02-plan

When planning new model-facing tools:

- Map the natural discovery granularity: does the model encounter items one-at-a-time or in batches?
- Design `input` and return types to match batch granularity
- Write the tool description in plural form if batching is expected
- Plan tests for bulk edge cases: empty array, single item, many items, duplicate descriptions

### For 04-review

When reviewing tools that consume or produce lists:

- Flag tools where the model would naturally batch but the API accepts only a single item — unless there's a compelling reason (e.g., each item requires interactive confirmation)
- Verify the tool description uses plural language if batching is supported
- Verify the return type provides per-item identifiers (indexes, IDs) for immediate reference

## Provenance

- **Source brainstorm:** `docs/brainstorms/2026-06-19-checklist-tools-requirements.md`
- **Source plan:** `docs/plans/2026-06-19-checklist-tools-plan.md`
- **Source review:** `docs/reviews/2026-06-19-checklist-tools.md`
- **Related solution:** `docs/solutions/workflow/tool-based-task-tracking-with-handoff-gating.md` (overall checklist tools architecture)
- **Source files:**
  - `extensions/ce-core/tools/checklist.ts` — `createChecklistAddTool` with bulk API
  - `extensions/ce-core/index.ts` — TypeBox schema `descriptions: Type.Array(Type.String())`
  - `tests/checklist.test.ts` — Bulk add tests (0, 1, multiple items)
