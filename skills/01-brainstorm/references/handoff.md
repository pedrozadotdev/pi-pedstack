# Handoff from 01-brainstorm

When the requirements artifact is ready:

1. Report the artifact path under `docs/brainstorms/`.
2. Summarize the recommended direction in 2-3 bullets.
3. The extension auto-advances to `02-plan` after handoff save; mention `/ped-next` only as a manual escape hatch.
4. If key ambiguity remains, say so before handing off.
5. Provide `🧠 Context Status` (health, handoff path, active files, new-session recommendation).
6. Save/mention handoff-lite path under `.context/compound-engineering/handoffs/` using the shared `Handoff-lite template` in `skills/references/pipeline-config.md`.
7. Recommend new session only when cross-phase + health is heavy/critical, and include a copyable prompt.
8. Before the handoff save, run `stage_gate` for `01-brainstorm`; deterministic failures block the save in both `shadow` and `enforce`. An `escalate` action means: stop the stage loop and ask the operator to run `/ped-reload` (under enforced routing the persisted escalation re-enters this stage under `models.sota`; in shadow mode the decision is recorded but not applied); do not continue with the current execution model.
