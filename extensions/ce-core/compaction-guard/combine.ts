// Compaction-guard pure core (plan Unit 2): frozen questions, request build +
// byte bounding, answer validation, good-boundary/action derivation, and
// signature hashing. No I/O; Jev is asked four atomic `noul` questions and
// never writes a verdict.
import type {
	JevNoulQuestion,
	JevQuestion,
	JevRequest,
	JevResult,
} from "../jev/types";
import { sha256ShortHex, stableStringify } from "../utils/canonical-json";
import { redactSecrets } from "../utils/redact";
import { truncateUtf8ToBytes as truncateToBytes } from "../utils/solution-recall";
import {
	MAX_REQUEST_BODY_BYTES,
	MIN_CONFIDENCE,
	PRIOR_SUMMARY_BYTES,
	RECENT_ENTRIES,
	RECENT_EXCERPT_BYTES,
} from "./facts";
import type {
	CompactionAction,
	CompactionDimension,
	CompactionDimensionId,
	CompactionFacts,
	CompactionOutcome,
	CompactionState,
} from "./types";

/** Bumped whenever the question copy or thresholds change (AD-2). */
export const THRESHOLDS_VERSION = 1;
/** `task_switch` at/above this satisfies the boundary clause. */
export const TASK_SWITCH_MIN = 0.5;
/** `meaningful_boundary` at/above this satisfies the boundary clause. */
export const MEANINGFUL_BOUNDARY_MIN = 0.5;
/** `history_need` must be below this for a good boundary. */
export const HISTORY_NEED_MAX = 0.5;
/** `mid_operation` must be below this for a good boundary. */
export const MID_OPERATION_MAX = 0.6;

/** The four frozen question ids, in ask order. */
export const COMPACTION_QUESTION_IDS: readonly CompactionDimensionId[] = [
	"task_switch",
	"meaningful_boundary",
	"history_need",
	"mid_operation",
];

/** Frozen calibration copy (a change is a `THRESHOLDS_VERSION` bump). */
export const QUESTION_COPY: Record<
	CompactionDimensionId,
	{ instructions: string; true: string; false: string }
> = {
	task_switch: {
		instructions:
			"Does this compaction point fall at a task switch (a clean hand-off " +
			"to new work) rather than mid-task?",
		true: "The cut point coincides with a task switch.",
		false: "The cut point does not coincide with a task switch.",
	},
	meaningful_boundary: {
		instructions:
			"Does this compaction point fall on a meaningful work boundary?",
		true: "The cut point falls on a meaningful work boundary.",
		false: "The cut point does not fall on a meaningful work boundary.",
	},
	history_need: {
		instructions:
			"Does the in-flight work still need its earlier conversation history " +
			"to continue correctly?",
		true: "The work needs the earlier history to continue.",
		false: "The work does not need the earlier history.",
	},
	mid_operation: {
		instructions:
			"Would compaction cut in the middle of a live multi-step operation?",
		true: "Compaction would split a live multi-step operation.",
		false: "Compaction would not split a live operation.",
	},
};

// ── Request building + byte bounding ────────────────────────────────

function toStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export interface BuildCompactionStateInput {
	facts: CompactionFacts;
	isSplitTurn?: unknown;
	recentEntries?: unknown;
	priorSummary?: unknown;
}

/** Shape-guard the event-derived semantic state; pressure fields come from facts. */
export function buildCompactionState(
	input: BuildCompactionStateInput,
): CompactionState {
	return {
		isSplitTurn: input.isSplitTurn === true,
		recentEntries: toStringArray(input.recentEntries),
		priorSummary:
			typeof input.priorSummary === "string" ? input.priorSummary : "",
		tokensBefore: input.facts.tokensBefore,
		overageTokens: input.facts.overageTokens,
		pressure: input.facts.pressure,
	};
}

function buildQuestions(): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	for (const id of COMPACTION_QUESTION_IDS) {
		const copy = QUESTION_COPY[id];
		questions[id] = {
			type: "noul",
			instructions: copy.instructions,
			criteria: { true: copy.true, false: copy.false },
		} satisfies JevNoulQuestion;
	}
	return questions;
}

/** Redact + byte-cap the semantic excerpt before any egress (AD-7). */
function buildStatePayload(state: CompactionState): Record<string, unknown> {
	return {
		isSplitTurn: state.isSplitTurn,
		recentEntries: state.recentEntries
			.slice(0, RECENT_ENTRIES)
			.map((entry) =>
				truncateToBytes(redactSecrets(entry), RECENT_EXCERPT_BYTES),
			),
		priorSummary: truncateToBytes(
			redactSecrets(state.priorSummary),
			PRIOR_SUMMARY_BYTES,
		),
		tokensBefore: state.tokensBefore,
		overageTokens: state.overageTokens,
		pressure: state.pressure,
	};
}

/** Serialize a compact state for one bounded `decide()` request. */
export function buildCompactionRequest(state: CompactionState): JevRequest {
	return { state: buildStatePayload(state), questions: buildQuestions() };
}

function requestBodyBytes(request: JevRequest): number {
	try {
		return Buffer.byteLength(JSON.stringify(request), "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

type LadderStep = (payload: Record<string, unknown>) => void;

function shrinkString(key: string, max: number): LadderStep {
	return (payload) => {
		const value = payload[key];
		if (typeof value === "string") {
			payload[key] = truncateToBytes(value, max);
		}
	};
}

function shrinkEntries(max: number): LadderStep {
	return (payload) => {
		if (!Array.isArray(payload.recentEntries)) return;
		payload.recentEntries = payload.recentEntries.map((entry) =>
			typeof entry === "string" ? truncateToBytes(entry, max) : entry,
		);
	};
}

function trimEntries(limit: number): LadderStep {
	return (payload) => {
		if (Array.isArray(payload.recentEntries)) {
			payload.recentEntries = payload.recentEntries.slice(0, limit);
		}
	};
}

// Ladder order: summary bulk → entry bulk → entry count → drop.
const TRUNCATION_LADDER: readonly LadderStep[] = [
	shrinkString("priorSummary", PRIOR_SUMMARY_BYTES / 2),
	shrinkString("priorSummary", 0),
	shrinkEntries(RECENT_EXCERPT_BYTES / 2),
	shrinkEntries(0),
	trimEntries(3),
	trimEntries(1),
	trimEntries(0),
];

/**
 * Truncation ladder (plan Unit 2). Mutates the request and stops as soon as the
 * body is under the cap; never throws.
 */
export function enforceRequestBodyLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const payload = request.state as unknown;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const record = payload as Record<string, unknown>;
	for (const step of TRUNCATION_LADDER) {
		step(record);
		if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	}
	record.recentEntries = [];
	record.priorSummary = "";
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
export function readAnswers(result: JevResult): CompactionDimension[] | string {
	const answered = new Map<CompactionDimensionId, CompactionDimension>();
	for (const id of COMPACTION_QUESTION_IDS) {
		const answer = result.answers?.[id];
		if (!answer || answer.type !== "noul") {
			return `missing or invalid noul answer for ${id}`;
		}
		if (!isUnitNumber(answer.noul)) {
			return `answer for ${id} must be a finite value in [0,1]`;
		}
		const rawConfidence = (answer as { confidence?: unknown }).confidence;
		const confidence = rawConfidence === undefined ? 1 : rawConfidence;
		if (!isUnitNumber(confidence) || confidence < MIN_CONFIDENCE) {
			return `answer for ${id} is below the confidence floor (${MIN_CONFIDENCE})`;
		}
		answered.set(id, { id, value: answer.noul, confidence });
	}
	return COMPACTION_QUESTION_IDS.map((id) => answered.get(id)).filter(
		(entry): entry is CompactionDimension => entry !== undefined,
	);
}

// ── Derivation ──────────────────────────────────────────────────────

function valueOf(
	dimensions: CompactionDimension[],
	id: CompactionDimensionId,
): number {
	return dimensions.find((entry) => entry.id === id)?.value ?? 0;
}

/**
 * Frozen good-boundary rule (plan Unit 2):
 * `(task_switch >= 0.5 OR meaningful_boundary >= 0.5) AND history_need < 0.5
 * AND mid_operation < 0.6`.
 */
export function deriveGoodBoundary(dimensions: CompactionDimension[]): boolean {
	const boundary =
		valueOf(dimensions, "task_switch") >= TASK_SWITCH_MIN ||
		valueOf(dimensions, "meaningful_boundary") >= MEANINGFUL_BOUNDARY_MIN;
	return (
		boundary &&
		valueOf(dimensions, "history_need") < HISTORY_NEED_MAX &&
		valueOf(dimensions, "mid_operation") < MID_OPERATION_MAX
	);
}

/** A good boundary allows stock compaction; anything else is a defer candidate. */
export function deriveAction(
	dimensions: CompactionDimension[],
): CompactionAction {
	return deriveGoodBoundary(dimensions) ? "allow" : "defer";
}

/** Wrap a fresh Jev judgment as an outcome; provenance stays `jev`. */
export function deriveOutcome(
	dimensions: CompactionDimension[],
): CompactionOutcome {
	return {
		action: deriveAction(dimensions),
		source: "jev",
		dimensions,
	};
}

// ── Signature ───────────────────────────────────────────────────────

/** Semantic-only projection: volatile pressure fields never change the signature. */
export function canonicalizeCompactionState(state: CompactionState): string {
	return stableStringify({
		isSplitTurn: state.isSplitTurn,
		recentEntries: state.recentEntries,
		priorSummary: state.priorSummary,
	});
}

export function hashCompactionSignature(state: CompactionState): string {
	return sha256ShortHex(canonicalizeCompactionState(state));
}
