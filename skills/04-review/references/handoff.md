# Handoff from 04-review

When the review is complete:

1. Keep this stage **review-only**. Do not modify source, tests, config, or dependencies to address findings here.
2. Verify every finding against the codebase. Remove false positives from the compiled report.
3. Finalize the report's `## Review Outcome`:
   - confirmed findings remain → `Status: findings` and the exact non-zero `Findings` count
   - no confirmed findings remain → `Status: clean` and `Findings: 0`
4. Put the compiled `docs/reviews/*.md` path in `artifacts.review`.
5. If `multi_reviewer` returned `findingsRelativePath`, put it in `artifacts.reviewFindings`; do not replace `artifacts.review` with the JSON sidecar.
6. Route based on the report outcome:
   - `findings` → save the handoff with `nextStage: "03-work"`; carry the highest-priority findings and report path so work fixes them.
   - `clean` → save the handoff with `nextStage: "05-learn"`.
7. Never carry unresolved review findings into `05-learn`. `context_handoff save` validates the route against the report and blocks an inconsistent transition.
8. Provide `🧠 Context Status` (health, handoff path, active files, new-session recommendation).
9. Save/mention handoff-lite path under `.context/compound-engineering/handoffs/` using the shared `Handoff-lite template` in `skills/references/pipeline-config.md`.
10. Before the handoff save, run `stage_gate` for `04-review`; deterministic failures block the save. An `escalate` action means: stop the stage loop and ask the operator to run `/ped-reload`. Under enforced routing (`routing.shadow: false`), the persisted escalation re-enters this same stage under `models.sota`; in shadow mode the decision is recorded but not applied. Do not continue with the current execution model or invoke `/ped-reload` yourself.

## Fix-forward loop

```text
03-work
  → 04-review
      → findings → 03-work
                    → 04-review
                        → clean → 05-learn
```

The review gate judges whether the **review artifact** is complete and trustworthy. A gate `accept` does not mean the implementation is clean; the report's validated Review Outcome controls the next stage.
