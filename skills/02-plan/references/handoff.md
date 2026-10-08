# Handoff from 02-plan

When the plan is ready:

1. Report the plan path under `docs/plans/`.
2. Summarize the main implementation units.
3. The extension will prompt the user for authorization (gated transition: read the plan first) and then advance to `03-work`. `/ped-next` is the manual escape hatch.
4. Call out any remaining assumptions or open risks.
5. Provide `🧠 Context Status` (health, handoff path, active files, new-session recommendation).
6. Save/mention handoff-lite path under `.context/compound-engineering/handoffs/` using the shared `Handoff-lite template` in `skills/references/pipeline-config.md`.
7. Recommend new session only when cross-phase + health is heavy/critical, and include a copyable prompt.
8. Before the handoff save, run `stage_gate` for `02-plan`; deterministic failures block the save in both `shadow` and `enforce`. An `escalate` action means: Stop the current stage loop and do not invoke `/ped-reload` yourself. Under enforced routing (`routing.shadow: false`), Pedstack automatically re-enters the same stage under `models.sota` after this turn ends; if that fails, the operator can use `/ped-reload` manually. Shadow mode records the decision but does not switch models.
