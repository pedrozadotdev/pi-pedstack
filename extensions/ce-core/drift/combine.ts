// Drift pure core (plan Unit 2): thresholds, pinned question copy, request
// build + byte bounding, answer validation, verdict/streak derivation, turn
// signature hashing, and redaction. No I/O.
import type { JevNoulQuestion, JevQuestion, JevRequest, JevResult } from "../jev/types";
import { sha256ShortHex, stableStringify } from "../utils/canonical-json";
import { redactSecrets } from "../utils/redact";
import { truncateUtf8ToBytes as truncateToBytes } from "../utils/solution-recall";
import type {
	CorrectionDimensionId,
	DerivedVerdict,
	DeriveContext,
	DriftDimension,
	DriftDimensionId,
	DriftTurnState,
	DriftVerdict,
} from "./types";

/** Bumped whenever the question copy or thresholds change (AD-2). */
export const THRESHOLDS_VERSION = 2;
/** Confidence floor applied to every Jev answer (not a value threshold). */
export const MIN_CONFIDENCE = 0.5;
/** `in_stage_scope` below this = out-of-scope (soft signal). */
export const IN_SCOPE_MIN = 0.5;
/** `forbidden_work` at/above this = mild signal (FT-1). */
export const FORBIDDEN_WORK_MILD = 0.6;
/** `forbidden_work` at/above this AND `STRONG_CONFIDENCE` = hard strong (FT-2). */
export const FORBIDDEN_WORK_STRONG = 0.8;
/** Confidence gate for the hard-block tier only (D5). */
export const STRONG_CONFIDENCE = 0.6;
/** `scope_drift` at/above this = scope-change signal (soft). */
export const SCOPE_DRIFT_STRONG = 0.6;
/** Consecutive mild (jev source only) escalates to strong. */
export const MILD_REPEAT_LIMIT = 2;

/** Frozen config/limits (plan "Frozen config/limits"). */
export const DRIFT_JEV_TIMEOUT_MS = 8_000;
export const MAX_DRIFT_JEV_CALLS_PER_SESSION = 24;
export const DRIFT_CLEAR_STREAK = 2;
export const DRIFT_RECORD_TTL_MS = 6 * 60 * 60 * 1_000;
export const EXCERPT_BYTES = 1_024;
export const ACTION_TARGET_BYTES = 160;
export const ACTION_REASON_BYTES = 200;
export const MAX_ACTIONS = 20;
export const MAX_REQUEST_BODY_BYTES = 16_384;

/** UTF-8 byte cap with a truncation marker (shared with solution recall). */
export { truncateToBytes };

/** The four frozen question ids, in ask order. */
export const DRIFT_QUESTION_IDS: readonly DriftDimensionId[] = [
	"in_stage_scope",
	"forbidden_work",
	"scope_drift",
	"progress",
];

/** Frozen calibration copy (a change is a `THRESHOLDS_VERSION` bump). */
export const QUESTION_COPY: Record<
	DriftDimensionId,
	{ instructions: string; true: string; false: string }
> = {
	in_stage_scope: {
		instructions:
			"Is the work in this turn within the active stage's mandate?",
		true: "The turn advances the stage's stated mandate.",
		false: "The turn left the stage's mandate.",
	},
	forbidden_work: {
		instructions:
			"Is this turn an activity this stage's policy forbids " +
			"(implementation in brainstorm/plan, fixing in review, source edits in " +
			"learn/docsync)?",
		true: "The turn performs an activity the stage policy forbids.",
		false: "The turn does not perform a policy-forbidden activity.",
	},
	scope_drift: {
		instructions:
			"Did this turn change or expand approved scope instead of " +
			"advancing it?",
		true: "The turn changed or expanded scope that was not previously approved.",
		false: "The turn advanced the existing scope.",
	},
	progress: {
		instructions:
			"Did this turn advance the stage's deliverable rather than " +
			"stall or loop?",
		true: "The turn made concrete progress toward the deliverable.",
		false: "The turn stalled, looped, or produced nothing.",
	},
};

// ── Redaction (AD-7: re-exported from utils/redact for call-site stability) ──

export { redactSecrets };

// ── Request building + byte bounding ────────────────────────────────

function buildQuestions(): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	for (const id of DRIFT_QUESTION_IDS) {
		const copy = QUESTION_COPY[id];
		questions[id] = {
			type: "noul",
			instructions: copy.instructions,
			criteria: { true: copy.true, false: copy.false },
		} satisfies JevNoulQuestion;
	}
	return questions;
}

/** Serialize a compact turn state for one bounded `decide()` request. */
export function buildDriftRequest(state: DriftTurnState): JevRequest {
	return {
		state: {
			stage: state.stage,
			mandate: state.mandate,
			forbidden: state.forbidden,
			actions: state.actions.map((action) => ({
				tool: action.tool,
				effect: action.effect,
				target: truncateToBytes(action.target, ACTION_TARGET_BYTES),
				error: action.error,
				...(action.blocked ? { blocked: true } : {}),
				...(action.reason
					? { reason: truncateToBytes(action.reason, ACTION_REASON_BYTES) }
					: {}),
			})),
			assistantExcerpt: truncateToBytes(state.assistantExcerpt, EXCERPT_BYTES),
			wroteStageArtifact: state.wroteStageArtifact,
		},
		questions: buildQuestions(),
	};
}

function requestBodyBytes(request: JevRequest): number {
	try {
		return Buffer.byteLength(JSON.stringify(request), "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

type LadderStep = (state: Record<string, unknown>) => void;

function shrinkString(key: string, max: number): LadderStep {
	return (state) => {
		const value = state[key];
		if (typeof value === "string") {
			state[key] = truncateToBytes(value, max);
		}
	};
}

function shrinkActionField(field: string, max: number): LadderStep {
	return (state) => {
		const actions = state.actions;
		if (!Array.isArray(actions)) return;
		for (const action of actions) {
			if (!action || typeof action !== "object") continue;
			const record = action as Record<string, unknown>;
			if (typeof record[field] === "string") {
				record[field] = truncateToBytes(record[field] as string, max);
			}
		}
	};
}

function trimActions(limit: number): LadderStep {
	return (state) => {
		if (Array.isArray(state.actions)) state.actions = state.actions.slice(0, limit);
	};
}

function dropActions(): LadderStep {
	return (state) => {
		state.actions = [];
	};
}

// Ladder order: excerpt bulk → action literals/reasons → action count → drop.
const TRUNCATION_LADDER: readonly LadderStep[] = [
	shrinkString("assistantExcerpt", EXCERPT_BYTES / 2),
	shrinkString("assistantExcerpt", 0),
	shrinkActionField("target", 32),
	shrinkActionField("reason", 32),
	shrinkActionField("target", 0),
	shrinkActionField("reason", 0),
	trimActions(10),
	trimActions(5),
	trimActions(2),
	dropActions(),
];

/**
 * Truncation ladder (plan Unit 2). Mutates the request and stops as soon as the
 * body is under the cap; never throws.
 */
export function enforceRequestBodyLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const state = request.state as unknown;
	if (!state || typeof state !== "object" || Array.isArray(state)) return;
	const record = state as Record<string, unknown>;
	for (const step of TRUNCATION_LADDER) {
		step(record);
		if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	}
	record.actions = [];
	record.assistantExcerpt = "";
}

// ── Answer validation ───────────────────────────────────────────────

function isUnitNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

/**
 * Read the four `noul` answers, rejecting any missing/low-confidence/invalid
 * answer as a degraded reason string. Returns dimensions in ask order.
 */
export function readAnswers(
	result: JevResult,
): DriftDimension[] | string {
	const answered = new Map<DriftDimensionId, DriftDimension>();
	for (const id of DRIFT_QUESTION_IDS) {
		const answer = result.answers?.[id];
		if (!answer || answer.type !== "noul") {
			return `missing or invalid noul answer for ${id}`;
		}
		if (!isUnitNumber(answer.noul)) {
			return `answer for ${id} must be a finite value in [0,1]`;
		}
		const confidence = (answer as { confidence?: unknown }).confidence;
		if (!isUnitNumber(confidence) || confidence < MIN_CONFIDENCE) {
			return `answer for ${id} is absent or below the confidence floor (${MIN_CONFIDENCE})`;
		}
		answered.set(id, { id, value: answer.noul, confidence });
	}
	return DRIFT_QUESTION_IDS.map((id) => answered.get(id)).filter(
		(entry): entry is DriftDimension => entry !== undefined,
	);
}

// ── Verdict derivation (AD-2 table + AD-6 clear rule) ───────────────

/**
 * Derive `no_drift | mild_drift | strong_drift` plus the next streak counters.
 *
 * `forbidden_work` is a hard signal and is excluded from the soft count so one
 * underlying observation can never count twice. A prior strong verdict blocks
 * until a jev `no_drift` turn writes the stage artifact or reaches the clear
 * streak; a prior strong verdict is never dropped by a degraded/deterministic
 * context (callers pass 0/undefined for those).
 */
interface Signals {
	triggered: DriftDimensionId[];
	soft: number;
	forbiddenStrong: boolean;
}

/** The D4 recurrence knob; invalid values fall back to the default of 2. */
function resolveMildRepeatLimit(value?: number): number {
	return Number.isFinite(value)
		? Math.max(2, Math.floor(value as number))
		: MILD_REPEAT_LIMIT;
}

/**
 * Threshold the four dimensions against the frozen table (FT-1..FT-5).
 * `forbidden_work` is tiered (mild vs strong) and only its mild tier counts as
 * a soft signal; `progress` is supporting-only and never triggers.
 */
function computeSignals(dimensions: DriftDimension[]): Signals {
	const find = (id: DriftDimensionId): DriftDimension | undefined =>
		dimensions.find((entry) => entry.id === id);
	const value = (id: DriftDimensionId): number => find(id)?.value ?? 0;
	const confidence = (id: DriftDimensionId): number =>
		find(id)?.confidence ?? 0;

	const forbiddenValue = value("forbidden_work");
	const forbiddenStrong =
		forbiddenValue >= FORBIDDEN_WORK_STRONG &&
		confidence("forbidden_work") >= STRONG_CONFIDENCE;
	const forbiddenMild =
		forbiddenValue >= FORBIDDEN_WORK_MILD && !forbiddenStrong;

	const triggered: DriftDimensionId[] = [];
	const outOfScope = value("in_stage_scope") < IN_SCOPE_MIN;
	const scopeDrift = value("scope_drift") >= SCOPE_DRIFT_STRONG;
	if (outOfScope) triggered.push("in_stage_scope");
	if (forbiddenValue >= FORBIDDEN_WORK_MILD) triggered.push("forbidden_work");
	if (scopeDrift) triggered.push("scope_drift");

	return {
		triggered,
		soft: (outOfScope ? 1 : 0) + (scopeDrift ? 1 : 0) + (forbiddenMild ? 1 : 0),
		forbiddenStrong,
	};
}

export function deriveVerdict(
	dimensions: DriftDimension[],
	context: DeriveContext = {},
): DerivedVerdict {
	const { triggered, soft, forbiddenStrong } = computeSignals(dimensions);
	const priorMild = context.priorConsecutiveMild ?? 0;
	const limit = resolveMildRepeatLimit(context.mildRepeatLimit);
	const repeated = soft === 1 && priorMild >= limit - 1;
	let rawVerdict: DriftVerdict = "no_drift";
	if (forbiddenStrong || soft >= 2 || repeated) rawVerdict = "strong_drift";
	else if (soft === 1) rawVerdict = "mild_drift";

	if (rawVerdict === "strong_drift") {
		return {
			verdict: "strong_drift",
			triggered,
			consecutiveMild: 0,
			consecutiveNoDrift: 0,
		};
	}

	if (rawVerdict === "mild_drift") {
		return {
			// Keep an unresolved strong record blocking even on a mild turn.
			verdict:
				context.priorVerdict === "strong_drift"
					? "strong_drift"
					: "mild_drift",
			triggered,
			consecutiveMild: priorMild + 1,
			consecutiveNoDrift: 0,
		};
	}

	const nextNoDrift = (context.priorConsecutiveNoDrift ?? 0) + 1;
	const priorStrong = context.priorVerdict === "strong_drift";
	const cleared =
		context.wroteStageArtifact === true || nextNoDrift >= DRIFT_CLEAR_STREAK;
	return {
		verdict: priorStrong && !cleared ? "strong_drift" : "no_drift",
		triggered: [],
		consecutiveMild: 0,
		consecutiveNoDrift: nextNoDrift,
	};
}

/** One-shot correction copy for a correctable drift dimension (AD-3). */
export function correctionMessage(
	dimension: CorrectionDimensionId,
	stage: string,
): string {
	switch (dimension) {
		case "in_stage_scope":
			return `This turn left the ${stage} mandate. Return to in-scope work for ${stage}.`;
		case "forbidden_work":
			return `This turn performed an activity the ${stage} policy forbids. Stop and stay within the mandate.`;
		case "scope_drift":
			return `This turn changed scope that was not approved. Revert to the approved plan.`;
	}
}

// ── Turn signature ──────────────────────────────────────────────────

export function canonicalizeTurnState(state: DriftTurnState): string {
	return stableStringify(state);
}

export function hashTurnSignature(state: DriftTurnState): string {
	return sha256ShortHex(canonicalizeTurnState(state));
}

// ── Correction formatting (AD-3) ────────────────────────────────────

/** Pinned heading for the one-shot correction block. */
export const DRIFT_CORRECTION_HEADING = "## 🧭 Stage Drift Correction";

/**
 * Format the pending correction as a system-prompt block. Returns `undefined`
 * when there is nothing to inject, preserving `before_agent_start` chaining.
 */
export function formatDriftCorrection(
	text: string | undefined,
): string | undefined {
	if (!text) return undefined;
	return `\n\n---\n${DRIFT_CORRECTION_HEADING}\n\n${text}`;
}
