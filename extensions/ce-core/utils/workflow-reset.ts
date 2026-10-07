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

/**
 * Remove the workflow-scoped routing lifecycle state.
 *
 * Deletes only `.context/compound-engineering/routing/` (per-stage proactive
 * escalation budgets) and `.context/compound-engineering/stage-gates/`
 * (per-stage gate verdicts, attempts, and review actions). User artifacts,
 * handoffs, context state, and every other workflow store are left untouched.
 * Idempotent; callers decide whether an I/O failure should warn or abort.
 */
export async function resetWorkflowRoutingState(
	repoRoot: string,
): Promise<void> {
	await Promise.all([
		clearRoutingRecords(repoRoot),
		clearStageGateRecords(repoRoot),
	]);
}
