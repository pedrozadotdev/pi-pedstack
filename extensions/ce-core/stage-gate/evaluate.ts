// Gate engine (plan Unit 5): deterministic first, Jev second, TypeScript combine.
// A critical deterministic failure short-circuits with no Jev call (G2/G5).
import { JevRuntimeError } from "../jev/errors";
import type { JevAnswer, JevQuestion, JevRequest, JevRuntime } from "../jev/types";
import { combineVerdict } from "./combine";
import { computeArtifactsHash, gatherEvidence } from "./evidence";
import type { GatherEvidenceOptions } from "./evidence";
import { evaluateDeterministic, getStageRubric } from "./rubrics";
import { appendRecord, readAttempts } from "./store";
import type {
	DeterministicResult,
	Evidence,
	SemanticScore,
	SemanticScoreInput,
	StageGateAttempt,
	StageGateMode,
	StageGateVerdict,
	StageKey,
	StageRubric,
} from "./types";

/** Five score levels shared by every semantic dimension (plan calibration). */
const SCORE_LEVELS = ["absent", "weak", "partial", "solid", "exemplary"];

export interface StageGateDeps {
	runtime: JevRuntime;
	now?: () => Date;
	/** Injectable evidence gatherer (tests use the real one). */
	gather?: (options: GatherEvidenceOptions) => Promise<Evidence>;
}

export interface StageGateInput {
	repoRoot: string;
	stage: StageKey;
	mode: StageGateMode;
	artifactPaths?: string[];
	gitDiff?: string | null;
}

export interface StageGateResult {
	verdict: StageGateVerdict;
	weightedScore: number | null;
	criticalFailed: boolean;
	enforcing: boolean;
	jevUnavailable: boolean;
	jevReason: string | null;
	sem: SemanticScore[];
	det: DeterministicResult[];
	warnings: string[];
	artifacts: string[];
}

function buildRequest(
	evidence: Evidence,
	rubric: StageRubric,
	det: DeterministicResult[],
): JevRequest {
	const questions: Record<string, JevQuestion> = {};
	for (const dimension of rubric.semanticDimensions) {
		questions[dimension.id] = {
			type: "score",
			instructions: dimension.description,
			criteria: SCORE_LEVELS,
		};
	}
	return {
		state: {
			stage: evidence.stage,
			deterministic: det.map((entry) => ({
				id: entry.id,
				critical: entry.critical,
				pass: entry.pass,
				reason: entry.reason,
			})),
			artifact: evidence.txt,
		},
		questions,
	};
}

function toSemanticInputs(
	answers: Record<string, JevAnswer>,
	rubric: StageRubric,
): SemanticScoreInput[] {
	const inputs: SemanticScoreInput[] = [];
	for (const dimension of rubric.semanticDimensions) {
		const answer = answers[dimension.id];
		if (!answer || answer.type !== "score") continue;
		inputs.push({
			id: dimension.id,
			score: answer.score,
			levels: SCORE_LEVELS.length,
			confidence: answer.confidence,
			weight: dimension.weight,
		});
	}
	return inputs;
}

interface JevOutcome {
	inputs: SemanticScoreInput[];
	model: string;
	usage?: { input_tokens: number; output_tokens: number };
	unavailable: boolean;
	reason: string | null;
	warnings: string[];
}

async function scoreSemantics(
	runtime: JevRuntime,
	request: JevRequest,
	rubric: StageRubric,
): Promise<JevOutcome> {
	try {
		const result = await runtime.decide(request);
		return {
			inputs: toSemanticInputs(result.answers, rubric),
			model: result.model,
			usage: result.usage,
			unavailable: false,
			reason: null,
			warnings: result.warnings,
		};
	} catch (error) {
		if (!(error instanceof JevRuntimeError)) throw error;
		return {
			inputs: [],
			model: "typesafe/jev",
			unavailable: true,
			reason: error.message,
			warnings: [`Jev unavailable: ${error.message}`],
		};
	}
}

async function persist(
	repoRoot: string,
	stage: StageKey,
	mode: StageGateMode,
	attempt: Omit<StageGateAttempt, "schema" | "artifactsHash" | "updatedAt">,
	artifacts: string[],
	now: () => Date,
): Promise<void> {
	if (mode === "off") return;
	const artifactsHash = await computeArtifactsHash(repoRoot, artifacts);
	await appendRecord(repoRoot, {
		...attempt,
		schema: 1,
		artifactsHash,
		updatedAt: now().toISOString(),
	});
}

/** Evaluates one stage artifact and persists the combined verdict. */
export async function evaluateStageGate(
	deps: StageGateDeps,
	input: StageGateInput,
): Promise<StageGateResult> {
	const gather = deps.gather ?? gatherEvidence;
	const now = deps.now ?? (() => new Date());
	const rubric = getStageRubric(input.stage);
	const evidence = await gather({
		repoRoot: input.repoRoot,
		stage: input.stage,
		hint: input.artifactPaths,
		gitDiff: input.gitDiff ?? null,
	});
	const det = evaluateDeterministic(rubric, evidence);
	const attempts = (await readAttempts(input.repoRoot, input.stage)).filter(
		(entry) => entry.verdict === "revise",
	).length;

	const detFailed = det.some((entry) => !entry.pass);
	const outcome: JevOutcome = detFailed
		? {
				inputs: [],
				model: "typesafe/jev",
				unavailable: false,
				reason: null,
				warnings: [],
			}
		: await scoreSemantics(deps.runtime, buildRequest(evidence, rubric, det), rubric);

	const combined = combineVerdict({
		det,
		sem: outcome.inputs,
		attempts,
		jevUnavailable: outcome.unavailable,
	});
	const warnings = [...evidence.warnings, ...outcome.warnings];
	const enforcing = input.mode === "enforce";

	await persist(
		input.repoRoot,
		input.stage,
		input.mode,
		{
			stage: input.stage,
			verdict: combined.verdict,
			enforcing,
			weightedScore: combined.weightedScore,
			det,
			sem: combined.sem,
			criticalFailed: combined.criticalFailed,
			jevUnavailable: outcome.unavailable,
			jevReason: outcome.reason,
			model: outcome.model,
			usage: outcome.usage,
			warnings,
			artifacts: evidence.artifacts,
			attempt: attempts,
		},
		evidence.artifacts,
		now,
	);

	return {
		verdict: combined.verdict,
		weightedScore: combined.weightedScore,
		criticalFailed: combined.criticalFailed,
		enforcing,
		jevUnavailable: outcome.unavailable,
		jevReason: outcome.reason,
		sem: combined.sem,
		det,
		warnings,
		artifacts: evidence.artifacts,
	};
}
