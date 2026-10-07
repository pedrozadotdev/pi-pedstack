// Workflow-root reset: a genuinely new workflow must not inherit the previous
// workflow's proactive escalation budget or its persisted stage-gate
// escalation/review state.
//
// `/ped-start` and `/ped-fix-issues` are the only workflow roots. `/ped-next`,
// `/ped-reload`, and `/ped-debug` are continuation paths, so they must keep
// this state: `/ped-reload` in particular depends on the persisted stage-gate
// escalation to re-enter the same stage under `models.sota`.
import { clearRoutingRecords } from "./routing-store";
import { clearStageGateRecords } from "../stage-gate/store";

/** Removers invoked by the workflow reset; both are injectable for tests. */
export interface WorkflowResetOptions {
	/** Test seam; defaults to the real routing-store remover. */
	clearRouting?: (repoRoot: string) => Promise<void>;
	/** Test seam; defaults to the real stage-gate-store remover. */
	clearStageGate?: (repoRoot: string) => Promise<void>;
}

/**
 * Remove the workflow-scoped routing lifecycle state.
 *
 * Deletes only `.context/compound-engineering/routing/` (per-stage proactive
 * escalation budgets) and `.context/compound-engineering/stage-gates/`
 * (per-stage gate verdicts, attempts, and review actions). User artifacts,
 * handoffs, context state, and every other workflow store are left untouched.
 *
 * Rejects when either removal fails, so callers can abort workflow
 * initialization instead of silently starting with stale state. A partial
 * removal is acceptable: both removers are force-idempotent, so a subsequent
 * successful retry clears whatever remained.
 */
export async function resetWorkflowRoutingState(
	repoRoot: string,
	options: WorkflowResetOptions = {},
): Promise<void> {
	await Promise.all([
		(options.clearRouting ?? clearRoutingRecords)(repoRoot),
		(options.clearStageGate ?? clearStageGateRecords)(repoRoot),
	]);
}
