# Handoff from 03-work

When execution reaches a meaningful checkpoint:

1. Summarize what was completed.
2. Report the latest verification results.
3. The extension auto-advances to `04-review` after handoff save; `/ped-next` remains the manual escape hatch.
4. Mention any remaining implementation risk.
5. Include checkpoint fields: `activeFiles`, `currentUnit`, `blocker`, `verification`, `contextTiers`, `handoffPath`.
6. Provide `🧠 Context Status` (health, handoff path, active files, new-session recommendation).
7. Save/mention handoff-lite path under `.context/compound-engineering/handoffs/` using the shared `Handoff-lite template` in `skills/references/pipeline-config.md`.
8. Recommend new session only when cross-phase + health is heavy/critical, and include a copyable prompt.
9. Before the handoff save, run `stage_gate` for `03-work` with the stage report at `.context/compound-engineering/stage-reports/03-work.md`; deterministic failures block the save in both `shadow` and `enforce`. `03-work` cannot escalate to SOTA; a failing gate continues to require in-scope revisions, even after its revision budget.
