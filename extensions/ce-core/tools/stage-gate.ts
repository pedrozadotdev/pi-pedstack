// `stage_gate` tool (plan Unit 6). Path-only inputs; the engine reads evidence
// from disk, so the model can never self-grade by injecting favorable text.
import { Type } from "typebox";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import { hasIndependentReviewer } from "../review/policy";
import { evaluateStageGate } from "../stage-gate/evaluate";
import type { GatherEvidenceOptions } from "../stage-gate/evidence";
import { isStageKey } from "../stage-gate/store";
import { getConfigKeyForSkill, readPiPedstackConfig } from "../utils/config-types";
import type { OverengineeringMode } from "../overengineering/types";
import type {
	DeterministicResult,
	Evidence,
	ReviewAction,
	SemanticScore,
	StageGateMode,
	StageGateVerdict,
} from "../stage-gate/types";

export const stageGateParams = Type.Object({
	repoRoot: Type.String({ description: "Repository root" }),
	stage: Type.String({
		description:
			"Pipeline stage key, e.g. 01-brainstorm, 02-plan, 03-work, 04-review, 04-5-debug, 05-learn, 06-docsync",
	}),
	artifactPaths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional repo-relative artifact path hints; validated to stay inside the repo and the stage's declared directory",
		}),
	),
});

export interface StageGateToolDeps {
	mode: StageGateMode;
	/** Resolved once at init; defaults to `shadow` when absent. */
	overengineeringMode?: OverengineeringMode;
	/** Injected runtime for tests; lazily created otherwise. */
	runtime?: JevRuntime;
	now?: () => Date;
	gather?: (options: GatherEvidenceOptions) => Promise<Evidence>;
}

interface StageGateToolInput {
	repoRoot: string;
	stage: string;
	artifactPaths?: string[];
}

interface StageGateToolResult {
	stage: string;
	skipped?: boolean;
	error?: string;
	verdict?: StageGateVerdict;
	action?: ReviewAction;
	actionReason?: string;
	weightedScore?: number | null;
	criticalFailed?: boolean;
	enforcing?: boolean;
	jevUnavailable?: boolean;
	jevReason?: string | null;
	sem?: SemanticScore[];
	det?: DeterministicResult[];
	warnings?: string[];
	artifacts?: string[];
}

/** Creates the `stage_gate` tool with the mode resolved once at init. */
export function createStageGateTool(deps: StageGateToolDeps) {
	let runtime: JevRuntime | null = deps.runtime ?? null;
	const getRuntime = (): JevRuntime => {
		if (!runtime) runtime = createJevRuntime();
		return runtime;
	};

	return {
		name: "stage_gate",
		async execute(input: StageGateToolInput): Promise<StageGateToolResult> {
			if (!isStageKey(input.stage)) {
				return {
					stage: input.stage,
					error: `unknown stage "${input.stage}"`,
				};
			}
			if (deps.mode === "off") {
				return {
					stage: input.stage,
					verdict: "accept",
					action: "none",
					actionReason:
						"stage gate disabled (PEDSTACK_STAGE_GATE=off); no review action",
					enforcing: false,
					skipped: true,
				};
			}
			const config = await readPiPedstackConfig(input.repoRoot);
			const configKey = getConfigKeyForSkill(input.stage);
			const reviewerAvailable = configKey
				? hasIndependentReviewer(config, configKey)
				: true;
			const result = await evaluateStageGate(
				{ runtime: getRuntime(), now: deps.now, gather: deps.gather },
				{
					repoRoot: input.repoRoot,
					stage: input.stage,
					mode: deps.mode,
					artifactPaths: input.artifactPaths,
					reviewerAvailable,
					overengineering: { mode: deps.overengineeringMode ?? "shadow" },
				},
			);
			return { stage: input.stage, ...result };
		},
	};
}
