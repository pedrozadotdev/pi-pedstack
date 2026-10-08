---
name: 06-docsync
description: "Synchronize project documentation after workflow completion. Follows doc-sync SKILL.md guidelines."
disable-model-invocation: true
---

# Sync Project Docs

This skill is executed at the end of a session, after implementing features, or when asked to update project documentation. It keeps human-facing documentation (`README.md`) and AI-facing rules (`AGENTS.md`) synchronized with recent changes.

See [shared pipeline instructions](~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/skills/references/pipeline-config.md) for model routing and pipeline behavior.

## Core rules

## Execution Workflow

### Step 1: Gather Session Telemetry

Analyze all changes made during this session. Extract file status, modifications, untracked files, and recent commits.

Identify:

- Modified files, new architectural boundaries, or newly added endpoints.
- Any new dependencies added to package manifests.
- New custom skills or workflow patterns established.

### Step 2: Evaluate and Update README.md

Determine if the changes alter user-facing behavior. Update Quick Start, Setup, or Usage examples if necessary.

### Step 3: Evaluate and Update AGENTS.md

Determine if changes alter AI behavior or constraints. Update Intent → Skill Mapping or Core Rules/Conventions. Maintain token efficiency (under 400 lines).

## Exit Criteria

- Both `README.md` and `AGENTS.md` reflect the current state of the repository accurately.
- No conflicting guidelines are introduced.
- The files are cleanly formatted and saved.

## Handoff

- Use `stage_report` with `stage: "06-docsync"` and complete `markdown` (README and AGENTS outcomes, verification, and an **Exit criteria** section). The tool creates the canonical `.context/compound-engineering/stage-reports/06-docsync.md` safely; do not try to use bash to create the directory.
- After `stage_report` succeeds, run `stage_gate` for `06-docsync` without `artifactPaths`, or pass the returned canonical report path. README and AGENTS are supporting documents, not valid stage gate artifact hints. Deterministic failures block the save in both `shadow` and `enforce`.
- `06-docsync` cannot escalate to SOTA. If its gate fails, correct the documentation/report and re-run `stage_gate`; do not restart the stage under a stronger model.
