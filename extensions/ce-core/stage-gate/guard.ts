// Save-side completion gate (plan Unit 7, AD-2). Always runs the pure
// deterministic floor; consults the record only for the semantic verdict.
import { evaluateDeterministic, getStageRubric } from "./rubrics";
import { gatherEvidence } from "./evidence";
import type { GatherEvidenceOptions } from "./evidence";
import { isCompletionSave, isRecordFresh, readAcceptRecord, resolvePriorGate } from "./store";
import type {
	DeterministicResult,
	Evidence,
	StageGateMode,
	StageKey,
} from "./types";

export interface CompletionGateDeps {
	/** Injectable evidence gatherer, used by the fail-open test. */
	gather?: (options: GatherEvidenceOptions) => Promise<Evidence>;
}

export interface CompletionGateResult {
	gated: boolean;
	allowed: boolean;
	blocker?: string;
	warning?: string;
	det: DeterministicResult[];
}

function recordVerdict(
	mode: StageGateMode,
	reason: string,
	det: DeterministicResult[],
): CompletionGateResult {
	if (mode === "enforce") {
		return {
			gated: true,
			allowed: false,
			blocker:
				`Cannot save cross-stage handoff: ${reason}. Run the stage_gate ` +
				"tool and resolve the verdict before saving.",
			det,
		};
	}
	return {
		gated: true,
		allowed: true,
		warning: `stage gate warning: ${reason}`,
		det,
	};
}

/**
 * Precedence (AD-2): gate exception → fail-open warning; critical deterministic
 * failure → block in both modes; enforce → require a fresh enforcing accept;
 * shadow → record a non-blocking warning.
 */
export async function evaluateCompletionGate(
	repoRoot: string,
	stage: string | undefined,
	nextStage: string | undefined,
	mode: StageGateMode,
	deps: CompletionGateDeps = {},
): Promise<CompletionGateResult> {
	if (mode === "off" || !isCompletionSave(stage, nextStage)) {
		return { gated: false, allowed: true, det: [] };
	}
	const stageKey = stage as StageKey;
	try {
		const gather = deps.gather ?? gatherEvidence;
		const priorGate = await resolvePriorGate(repoRoot, stageKey);
		const evidence = await gather({ repoRoot, stage: stageKey, priorGate });
		const det = evaluateDeterministic(getStageRubric(stageKey), evidence);
		const criticalFailure = det.find((entry) => entry.critical && !entry.pass);
		if (criticalFailure) {
			return {
				gated: true,
				allowed: false,
				blocker:
					`Cannot save cross-stage handoff: stage "${stageKey}" artifact ` +
					`failed the deterministic gate (${criticalFailure.id}: ` +
					`${criticalFailure.reason}). Fix the artifact and re-run stage_gate.`,
				det,
			};
		}
		const record = await readAcceptRecord(repoRoot, stageKey);
		if (!record) {
			return recordVerdict(mode, "no fresh enforcing accept record was found", det);
		}
		if (!(await isRecordFresh(repoRoot, record))) {
			return recordVerdict(
				mode,
				"the gate record is stale (artifact changed since scoring)",
				det,
			);
		}
		return { gated: true, allowed: true, det };
	} catch (error) {
		return {
			gated: true,
			allowed: true,
			warning: `stage gate failed open: ${
				error instanceof Error ? error.message : String(error)
			}`,
			det: [],
		};
	}
}
