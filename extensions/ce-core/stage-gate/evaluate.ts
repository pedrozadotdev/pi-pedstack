// Gate engine (plan Unit 5): deterministic first, Jev second, TypeScript combine.
// A critical deterministic failure short-circuits with no Jev call (G2/G5).
//
// Unit 6 adds the overengineering signal: four floor-only dimensions ride the
// single Jev request, and a deterministic trim ladder keeps it under the 64 KiB
// validator cap. `off`/`unavailable` leave the request byte-identical to a
// composer-off run.
import { JevRuntimeError } from "../jev/errors";
import type { JevAnswer, JevQuestion, JevRequest, JevRuntime } from "../jev/types";
import { BASELINE_MAX_BYTES } from "../overengineering/baseline";
import { composeOverengineeringSignal } from "../overengineering/compose";
import type { GitRunner } from "../overengineering/facts";
import { emptyOverengineeringFacts } from "../overengineering/facts";
import { appendOverengineeringShadow } from "../overengineering/shadow-log";
import {
	OVERENGINEERING_DIMENSION_IDS,
	type OverengineeringBaselines,
	type OverengineeringFacts,
	type OverengineeringMode,
	type OverengineeringRecord,
	type OverengineeringSignal,
} from "../overengineering/types";
import { truncateUtf8ToBytes } from "../utils/solution-recall";
import { combineVerdict } from "./combine";
import { computeArtifactsHash, gatherEvidence } from "./evidence";
import type { GatherEvidenceOptions } from "./evidence";
import { evaluateDeterministic, getStageRubric } from "./rubrics";
import { appendRecord, readAttempts, readLatestRecord, resolvePriorGate } from "./store";
import { resolveReviewAction } from "../review/policy";
import type {
	DeterministicResult,
	Evidence,
	ReviewAction,
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

/** The Jev validator's authoritative request cap (`jev/validate.ts`). */
export const MAX_REQUEST_BYTES = 65_536;

const OVER_DIMENSION_SET = new Set<string>(OVERENGINEERING_DIMENSION_IDS);

export interface StageGateOverengineeringOptions {
	mode: OverengineeringMode;
	runGit?: GitRunner;
	now?: () => Date;
}

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
	/** Whether an independent reviewer resolves from config; defaults to true. */
	reviewerAvailable?: boolean;
	overengineering?: StageGateOverengineeringOptions;
}

export interface StageGateResult {
	verdict: StageGateVerdict;
	/** The bounded action the pure review policy derives from the verdict (Unit 5). */
	action: ReviewAction;
	actionReason: string;
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

export interface BuiltStageGateRequest {
	request: JevRequest;
	/** The signal facts with the excerpt actually injected after trimming. */
	facts: OverengineeringFacts;
	/** True when the four questions were dropped to fit the 64 KiB cap. */
	requestTooLarge: boolean;
}

function offOverengineeringSignal(): OverengineeringSignal {
	return {
		status: "unavailable",
		baselines: {},
		baselinePaths: [],
		baselineHash: "",
		facts: emptyOverengineeringFacts([]),
		skippedDimensions: [],
		reason: "no_baseline",
	};
}

/** A signal-shaped value for the request builder; `buildRequest` filters dims. */
function trimmedBaselines(
	signal: OverengineeringSignal,
	cap: number,
): OverengineeringBaselines {
	const truncate = (ref: OverengineeringBaselines["requirements"]) =>
		ref
			? { ...ref, text: truncateUtf8ToBytes(ref.text, cap) }
			: undefined;
	return {
		requirements: truncate(signal.baselines.requirements),
		plan: truncate(signal.baselines.plan),
	};
}

function questionsFor(
	rubric: StageRubric,
	includeOver: boolean,
	skipped: Set<string>,
): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	for (const dimension of rubric.semanticDimensions) {
		if (OVER_DIMENSION_SET.has(dimension.id)) {
			if (!includeOver || skipped.has(dimension.id)) continue;
		}
		questions[dimension.id] = {
			type: "score",
			instructions: dimension.description,
			criteria: SCORE_LEVELS,
		};
	}
	return questions;
}

function buildCandidate(
	evidence: Evidence,
	rubric: StageRubric,
	det: DeterministicResult[],
	signal: OverengineeringSignal,
	options: { diffCap: number; baselineCap: number; includeOver: boolean },
): BuiltStageGateRequest {
	const includeOver = options.includeOver && signal.status === "ready";
	const state: Record<string, unknown> = {
		stage: evidence.stage,
		deterministic: det.map((entry) => ({
			id: entry.id,
			critical: entry.critical,
			pass: entry.pass,
			reason: entry.reason,
		})),
		artifact: evidence.txt,
	};
	let facts = signal.facts;
	if (includeOver) {
		const excerpt = truncateUtf8ToBytes(signal.facts.diffExcerpt, options.diffCap);
		facts = {
			...signal.facts,
			diffExcerpt: excerpt,
			diffExcerptBytes: Buffer.byteLength(excerpt, "utf8"),
		};
		state.baselines = trimmedBaselines(signal, options.baselineCap);
		state.complexityFacts = facts;
	}
	return {
		request: {
			state: state as Record<string, unknown>,
			questions: questionsFor(
				rubric,
				includeOver,
				new Set(signal.skippedDimensions.map((entry) => entry.dimension)),
			),
		},
		facts,
		requestTooLarge: false,
	};
}

function serializeBytes(request: JevRequest): number {
	return Buffer.byteLength(JSON.stringify(request), "utf8");
}

/**
 * Build the single Jev request, injecting the overengineering state/questions
 * only for a ready signal, then applying the size trim ladder until it fits the
 * 64 KiB cap. Returns the request and the facts actually injected.
 */
export function buildStageGateRequest(
	evidence: Evidence,
	rubric: StageRubric,
	det: DeterministicResult[],
	signal: OverengineeringSignal,
): BuiltStageGateRequest {
	const ladder: Array<{
		diffCap: number;
		baselineCap: number;
		includeOver: boolean;
	}> = [
		{ diffCap: 6144, baselineCap: BASELINE_MAX_BYTES, includeOver: true },
		{ diffCap: 3072, baselineCap: BASELINE_MAX_BYTES, includeOver: true },
		{ diffCap: 0, baselineCap: BASELINE_MAX_BYTES, includeOver: true },
		{ diffCap: 0, baselineCap: 1024, includeOver: true },
		{ diffCap: 0, baselineCap: 0, includeOver: true },
		{ diffCap: 0, baselineCap: 0, includeOver: false },
	];
	let last = buildCandidate(evidence, rubric, det, signal, {
		...ladder[0],
		includeOver: signal.status === "ready",
	});
	if (signal.status !== "ready") {
		return { ...last, requestTooLarge: false };
	}
	for (const step of ladder) {
		const candidate = buildCandidate(evidence, rubric, det, signal, step);
		last = candidate;
		if (serializeBytes(candidate.request) <= MAX_REQUEST_BYTES) {
			return { ...candidate, requestTooLarge: !step.includeOver };
		}
	}
	return { ...last, requestTooLarge: true };
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
	mode: StageGateMode,
	attempt: Omit<StageGateAttempt, "schema" | "artifactsHash" | "updatedAt">,
	artifacts: string[],
	now: () => Date,
): Promise<void> {
	if (mode === "off") return;
	const artifactsHash = await computeArtifactsHash(repoRoot, artifacts);
	await appendRecord(repoRoot, {
		...attempt,
		schema: 2,
		artifactsHash,
		updatedAt: now().toISOString(),
	});
}

/** Prior 02-plan overengineering reading, or null when none was recorded. */
async function readPriorPlanReading(repoRoot: string): Promise<number | null> {
	const record = await readLatestRecord(repoRoot, "02-plan");
	if (!record) return null;
	const over = record.sem.filter((entry) => OVER_DIMENSION_SET.has(entry.id));
	if (over.length === 0) return null;
	return (
		over.reduce((total, entry) => total + entry.normalized, 0) / over.length
	);
}

function toOverengineeringRecord(
	signal: OverengineeringSignal,
	facts: OverengineeringFacts,
	requestTooLarge: boolean,
): OverengineeringRecord {
	return {
		facts,
		baselinePaths: signal.baselinePaths,
		baselineHash: signal.baselineHash,
		skippedDimensions: signal.skippedDimensions,
		source: signal.status === "ready" && !requestTooLarge ? "jev" : "unavailable",
	};
}

/** Evaluates one stage artifact and persists the combined verdict. */
async function resolveOverengineeringSignal(
	input: StageGateInput,
	mode: OverengineeringMode,
): Promise<OverengineeringSignal> {
	if (mode === "off") return offOverengineeringSignal();
	return composeOverengineeringSignal({
		repoRoot: input.repoRoot,
		stage: input.stage,
		mode,
		runGit: input.overengineering?.runGit,
		now: input.overengineering?.now,
		priorPlanReading:
			input.stage === "03-work" ? await readPriorPlanReading(input.repoRoot) : null,
	});
}

async function resolveOutcome(
	detFailed: boolean,
	runtime: JevRuntime,
	request: JevRequest,
	rubric: StageRubric,
): Promise<JevOutcome> {
	if (detFailed) {
		return {
			inputs: [],
			model: "typesafe/jev",
			unavailable: false,
			reason: null,
			warnings: [],
		};
	}
	return scoreSemantics(runtime, request, rubric);
}

async function appendShadowLog(
	repoRoot: string,
	stage: StageKey,
	mode: OverengineeringMode,
	signal: OverengineeringSignal,
	record: OverengineeringRecord,
	sem: SemanticScore[],
	verdict: StageGateVerdict,
	now: () => Date,
): Promise<void> {
	if (mode === "off") return;
	await appendOverengineeringShadow(repoRoot, {
		ts: now().toISOString(),
		stage,
		mode,
		source: record.source,
		baselinePaths: signal.baselinePaths,
		baselineHash: signal.baselineHash,
		dimensions: sem
			.filter((entry) => OVER_DIMENSION_SET.has(entry.id))
			.map((entry) => ({
				id: entry.id as (typeof OVERENGINEERING_DIMENSION_IDS)[number],
				normalized: entry.normalized,
				score: entry.score,
			})),
		skippedDimensions: signal.skippedDimensions,
		verdict,
	});
}

/**
 * Independent reviews retained since the newest `accept`; an accept ends the
 * stage loop, so a later re-entry starts a fresh budget (Unit 5).
 */
function independentReviewCount(attempts: StageGateAttempt[]): number {
	let count = 0;
	for (let index = attempts.length - 1; index >= 0; index--) {
		const verdict = attempts[index].verdict;
		if (verdict === "accept") break;
		if (verdict === "review") count++;
	}
	return count;
}

/** Evaluates one stage artifact and persists the combined verdict. */
export async function evaluateStageGate(
	deps: StageGateDeps,
	input: StageGateInput,
): Promise<StageGateResult> {
	const gather = deps.gather ?? gatherEvidence;
	const now = deps.now ?? (() => new Date());
	const rubric = getStageRubric(input.stage);
	const overMode = input.overengineering?.mode ?? "shadow";
	const priorGate = await resolvePriorGate(input.repoRoot, input.stage);
	const evidence = await gather({
		repoRoot: input.repoRoot,
		stage: input.stage,
		hint: input.artifactPaths,
		gitDiff: input.gitDiff ?? null,
		priorGate,
	});
	const det = evaluateDeterministic(rubric, evidence);
	const priorAttempts = await readAttempts(input.repoRoot, input.stage);
	const attempts = priorAttempts.filter((entry) => entry.verdict === "revise").length;
	const independentReviews = independentReviewCount(priorAttempts);
	const signal = await resolveOverengineeringSignal(input, overMode);
	const built = buildStageGateRequest(evidence, rubric, det, signal);
	const outcome = await resolveOutcome(
		det.some((entry) => !entry.pass),
		deps.runtime,
		built.request,
		rubric,
	);

	const combined = combineVerdict({
		det,
		sem: outcome.inputs,
		attempts,
		jevUnavailable: outcome.unavailable,
		overengineeringEnforced: overMode === "enforce",
	});
	const review = resolveReviewAction({
		verdict: combined.verdict,
		independentReviews,
		reviewerAvailable: input.reviewerAvailable ?? true,
	});
	const warnings = [...evidence.warnings, ...outcome.warnings];
	const enforcing = input.mode === "enforce";
	const overengineering = toOverengineeringRecord(
		signal,
		built.facts,
		built.requestTooLarge,
	);

	await persist(
		input.repoRoot,
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
			overengineering,
			review,
		},
		[...evidence.artifacts, ...signal.baselinePaths],
		now,
	);
	await appendShadowLog(
		input.repoRoot,
		input.stage,
		overMode,
		signal,
		overengineering,
		combined.sem,
		combined.verdict,
		now,
	);

	return {
		verdict: combined.verdict,
		action: review.action,
		actionReason: review.reason,
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
