---
name: 01-brainstorm
description: "Discover requirements through structured multi-round dialog. Use when the request is ambiguous, needs discovery, or describes a new idea/product."
disable-model-invocation: true
---

# Brainstorm

Use this skill when the request is ambiguous, needs requirements discovery, or the user describes a new idea/product.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

- **Workflow Enforcement:** The step-by-step workflow (`01-brainstorm` → `02-plan` → `03-work` → `04-review` → `04-5-debug` → `05-learn` → `06-docsync`) is strictly required. The model must never skip this workflow, bypass individual steps, or go direct to implementation.
- **No Direct-to-Implementation Bypass:** Never jump straight to writing or editing codebase files, and never bypass brainstorming or planning to write/modify code. Keep the initial focus entirely on requirement discovery and design dialog.
- Use **`brainstorm_dialog`** to manage multi-round conversations (`start` → `refine` → `summarize`).
- Ask **one question at a time**.
- Compare **2-3 approaches** when multiple directions are plausible.
- Keep focused on **what** to build, not implementation details.
- **Explicit user approval required** before handoff to `02-plan`.
- Write result to `docs/brainstorms/` as durable requirements document.
- For design validation, the **`multi_reviewer`** tool is required (execute this every time) with `stepName: "01-brainstorm"` to review the drafted brainstorm/requirements artifact.
- **Task Tracking:** Before initiating the work in this stage, register your micro-tasks using `todo_add`. Continually check your list using `todo_list` and mark items complete with `todo_done`. **CRITICAL:** You must not execute `context_handoff` to the next stage if there are pending tasks on your list.

## Mode selection

After initial context, determine mode by asking the user directly in your response:

> What's your goal?
>
> - **Building a startup** → Startup Diagnostic
> - **Intrapreneurship** → Startup Diagnostic
> - **Side project / hackathon** → Builder Mode
> - **Adding a feature** → CE Brainstorm

Skip question if mode is obvious from request.

**Mode mapping:**

- Startup / intrapreneurship → **Startup Diagnostic** (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/startup-diagnostic.md`)
- Side project / hackathon → **Builder Mode** (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/builder-mode.md`)
- Feature addition → **CE Brainstorm** (see `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/ce-brainstorm-mode.md`)

## Mode summaries

| Mode | Key principle | End goal |
|---|---|---|
| Startup Diagnostic | Specificity is currency, narrow beats wide | One concrete next action |
| Builder Mode | Delight is currency, ship something showable | Concrete build steps |
| CE Brainstorm | Requirements clarity | Implementation-ready spec |

See reference files for full question sets and patterns.

## Premise Challenge

After mode-specific questions, run Premise Challenge. See `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/premise-challenge.md`.

## Design checklist

Before summarizing, ensure the design answers:

- What are we building?
- Why does it exist?
- What files/modules will change?
- What are the responsibility boundaries?
- What can fail, and how?
- How will we verify success?

## Domain vocabulary (optional)

After mode-specific questions, check if the project has a `CONTEXT.md` at root.
If not, and the brainstorm reveals 3+ domain-specific terms with ambiguous meanings,
offer to create one using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/context-glossary.md`. Update it inline during
the session — don't batch. If it exists, cross-reference and flag conflicts:

> "Your CONTEXT.md defines 'cancellation' as X, but you seem to mean Y — which is it?"

## Stop conditions

Stop and ask instead of guessing when: requirements conflict, success criteria unclear, task spans multiple systems, or user hasn't approved design.

## Approval gate

**Required:** Explicit user approval before handoff to `02-plan`.

## Workflow

1. Scan repository for nearby context
2. Check for existing `CONTEXT.md` at repo root
3. Determine mode (Startup / Builder / CE)
4. Run mode-specific questions (use reference files)
5. Run Premise Challenge
6. Generate 2-3 alternatives (minimal viable + ideal architecture)
7. Validate against design checklist
8. Offer to create/update `CONTEXT.md` if domain terms emerged
9. Use `brainstorm_dialog` `summarize` to finalize
10. Capture requirements in `docs/brainstorms/`
11. Invoke the **`multi_reviewer`** tool (required, execute this every time) with `stepName: "01-brainstorm"` to review the generated brainstorm/requirements artifact.
12. Get explicit user approval
13. Handoff to `02-plan` using `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/handoff.md`

## Artifact contract

Use `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/01-brainstorm/references/requirements-template.md` to structure the document. Keep implementation details out unless specifically about architecture.

Before finishing this skill, apply the completion checklist in [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md).
