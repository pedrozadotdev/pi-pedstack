// Pure verdict combination (plan Unit 3, R3/R4/R5/G3/G5). No I/O, no Jev.
import type {
	DeterministicResult,
	SemanticScore,
	SemanticScoreInput,
	StageGateVerdict,
} from "./types";

export const T_ACCEPT = 0.75;
export const T_REVIEW = 0.5;
export const DIM_FLOOR = 0.25;
export const MAX_REVISE = 2;

export interface CombineInput {
	det: DeterministicResult[];
	sem: SemanticScoreInput[];
	/** Prior `revise` records for this stage at evaluation time. */
	attempts: number;
	jevUnavailable: boolean;
}

export interface CombineResult {
	verdict: StageGateVerdict;
	weightedScore: number | null;
	criticalFailed: boolean;
	sem: SemanticScore[];
	reasons: string[];
}

/** Normalizes a raw Jev score to [0,1]; a level count < 2 scores 0. */
export function normalizeScore(score: number, levels: number): number {
	if (!Number.isFinite(levels) || levels < 2) return 0;
	const max = levels - 1;
	const clamped = Math.min(Math.max(score, 0), max);
	return clamped / max;
}

function normalizeAll(inputs: SemanticScoreInput[]): SemanticScore[] {
	return inputs.map((entry) => ({
		id: entry.id,
		score: entry.score,
		normalized: normalizeScore(entry.score, entry.levels),
		confidence: entry.confidence ?? 1,
		weight: entry.weight ?? 1,
	}));
}

function weightedAverage(scores: SemanticScore[]): number {
	const totalWeight = scores.reduce((total, entry) => total + entry.weight, 0);
	if (totalWeight <= 0) return 0;
	const weighted = scores.reduce(
		(total, entry) => total + entry.weight * entry.normalized,
		0,
	);
	return weighted / totalWeight;
}

function applyReviseBudget(
	verdict: StageGateVerdict,
	attempts: number,
	reasons: string[],
): StageGateVerdict {
	if (verdict !== "revise" || attempts < MAX_REVISE) return verdict;
	reasons.push(`revise budget exhausted (${MAX_REVISE}); escalating`);
	return "escalate";
}

/**
 * Combines deterministic results and semantic scores into exactly one verdict.
 * A critical deterministic failure is a hard floor: it can never become `accept`.
 */
export function combineVerdict(input: CombineInput): CombineResult {
	const reasons: string[] = [];
	const sem = normalizeAll(input.sem);
	const criticalFailed = input.det.some((entry) => entry.critical && !entry.pass);
	const detFailed = input.det.some((entry) => !entry.pass);
	const unavailable = input.jevUnavailable || sem.length === 0;

	if (detFailed) {
		reasons.push(
			criticalFailed
				? "critical deterministic check failed (hard verdict floor)"
				: "a deterministic check failed",
		);
		return finish("revise", null, criticalFailed, sem, reasons, input.attempts);
	}

	if (unavailable) {
		reasons.push("Jev unavailable: deterministic-only evaluation");
		return finish("accept", null, false, sem, reasons, input.attempts);
	}

	const weightedScore = weightedAverage(sem);
	const belowFloor = sem.some((entry) => entry.normalized < DIM_FLOOR);
	let verdict: StageGateVerdict;
	if (weightedScore >= T_ACCEPT && !belowFloor) {
		verdict = "accept";
	} else if (weightedScore >= T_REVIEW) {
		verdict = "review";
		if (belowFloor) reasons.push(`a dimension is below the ${DIM_FLOOR} floor`);
	} else {
		verdict = "revise";
	}
	if (verdict === "accept") reasons.push("deterministic and semantic contract satisfied");
	return finish(verdict, weightedScore, false, sem, reasons, input.attempts);
}

function finish(
	verdict: StageGateVerdict,
	weightedScore: number | null,
	criticalFailed: boolean,
	sem: SemanticScore[],
	reasons: string[],
	attempts: number,
): CombineResult {
	return {
		verdict: applyReviseBudget(verdict, attempts, reasons),
		weightedScore,
		criticalFailed,
		sem,
		reasons,
	};
}
