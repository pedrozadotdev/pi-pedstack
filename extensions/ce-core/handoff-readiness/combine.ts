// Handoff readiness — pure combination logic (plan Unit 2). No I/O.
// Canonicalization + hashing (Unit 1) live here too because both modules share
// the same frozen byte thresholds; `combine.ts` is their single owner.
import type { JevQuestion, JevRequest, JevResult } from "../jev/types";
import { sha256ShortHex, stableStringify } from "../utils/canonical-json";
import { truncateUtf8ToBytes } from "../utils/solution-recall";
import type {
	ReadinessCorrection,
	ReadinessDimension,
	ReadinessDimensionId,
	ReadinessOutcome,
	ReadinessSource,
	ReadinessState,
} from "./types";

export const THRESHOLDS_VERSION = 1;
/** Value threshold compared to a `noul` value. */
export const MIN_DIMENSION = 0.5;
/** `history_need` at/above this is strong enough to preserve the session. */
export const HISTORY_NEED_STRONG = 0.6;
/** `blocking_open_decisions` at/above this blocks progress. */
export const BLOCKING = 0.5;
/** Confidence floor applied to every Jev answer (not a value threshold). */
export const MIN_CONFIDENCE = 0.5;

export const MAX_REQUEST_BODY_BYTES = 65_536;
export const HANDOFF_MARKDOWN_BYTES = 32_768;
export const CURRENT_TASK_BYTES = 2_048;
export const ARRAY_ITEM_BYTES = 1_024;
export const READINESS_JEV_TIMEOUT_MS = 8_000;
export const TRUNCATION_MARKER = "…[truncated]";

/** The five frozen question ids, in ask order. */
export const READINESS_QUESTION_IDS: readonly ReadinessDimensionId[] = [
	"continuation_sufficiency",
	"next_step_clarity",
	"verification_support",
	"blocking_open_decisions",
	"history_need",
];

const PLACEHOLDER_VALUES = new Set([
	"",
	"-",
	"n/a",
	"na",
	"none",
	"not run",
	"todo",
	"tbd",
]);

/** Strips one leading markdown list marker (`- `, `* `) and surrounding space. */
function stripListMarker(value: string): string {
	return value.replace(/^\s*[-*]\s+/, "");
}

/**
 * Placeholder/not-run detection. Reimplemented locally (the tool's helper is
 * private and the two modules must not couple on a string list).
 */
export function isPlaceholderValue(value: string): boolean {
	const trimmed = stripListMarker(value).trim().toLowerCase();
	if (PLACEHOLDER_VALUES.has(trimmed)) return true;
	if (trimmed.startsWith("n/a ") || trimmed.startsWith("na ")) return true;
	return false;
}

function normalizeText(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeArray(items: string[]): string[] {
	return items
		.map(normalizeText)
		.filter((item) => item.length > 0 && !isPlaceholderValue(item));
}

/** Deterministic normalization so the same logical state always hashes alike. */
export function normalizeState(state: ReadinessState): ReadinessState {
	const artifacts: Record<string, string> = {};
	for (const [key, value] of Object.entries(state.artifacts)) {
		if (typeof value !== "string") continue;
		const normalized = normalizeText(value);
		if (normalized.length === 0 || isPlaceholderValue(normalized)) continue;
		artifacts[key] = normalized;
	}

	return {
		currentStage: normalizeText(state.currentStage),
		nextStage: normalizeText(state.nextStage),
		handoffMarkdown: normalizeText(state.handoffMarkdown),
		currentTask: normalizeText(state.currentTask),
		nextMinimalStep: normalizeText(state.nextMinimalStep),
		verification: normalizeText(state.verification),
		blocker: isPlaceholderValue(state.blocker)
			? ""
			: normalizeText(state.blocker),
		openDecisions: normalizeArray(state.openDecisions),
		currentTruth: normalizeArray(state.currentTruth),
		invalidatedAssumptions: normalizeArray(state.invalidatedAssumptions),
		activeFiles: normalizeArray(state.activeFiles),
		recentlyAccessedFiles: normalizeArray(state.recentlyAccessedFiles),
		artifacts,
		activeRules: normalizeArray(state.activeRules),
	};
}

export function canonicalizeState(state: ReadinessState): string {
	return stableStringify(state);
}

export function hashCanonical(canonical: string): string {
	return sha256ShortHex(canonical);
}

function isMeaningfulText(value: string | undefined): boolean {
	return Boolean(value && value.trim().length > 0 && !isPlaceholderValue(value));
}

function hasMeaningfulArray(items: string[]): boolean {
	return items.some((item) => isMeaningfulText(item));
}

/** The default template emits a bare `/ped-next`, which carries no next action. */
export function isBarePedNext(value: string): boolean {
	return stripListMarker(value).trim() === "/ped-next";
}

/** A forced dimension that already guarantees a non-`continue` outcome. */
function isFailureDimension(entry: ReadinessDimension): boolean {
	if (entry.id === "history_need") return false;
	if (entry.id === "blocking_open_decisions") return entry.value >= BLOCKING;
	return entry.value < MIN_DIMENSION;
}

/**
 * Deterministic short-circuits (no Jev call). Only four dimensions are ever
 * forceable; `continuation_sufficiency` and `history_need` are never fully
 * forced from semantics alone.
 */
export function prepass(
	state: ReadinessState,
	missingFiles: string[],
): { forced: ReadinessDimension[]; forcesNonContinue: boolean } {
	const forced: ReadinessDimension[] = [];
	const force = (id: ReadinessDimensionId, value: number): void => {
		forced.push({ id, value, confidence: 1, forced: true });
	};

	if (!hasMeaningfulArray(state.openDecisions)) {
		force("blocking_open_decisions", 0);
	}
	if (!isMeaningfulText(state.verification)) {
		force("verification_support", 0);
	}
	if (
		!isMeaningfulText(state.nextMinimalStep) ||
		isBarePedNext(state.nextMinimalStep)
	) {
		force("next_step_clarity", 0);
	}
	if (missingFiles.length > 0) {
		force("continuation_sufficiency", 0);
	}

	return {
		forced,
		forcesNonContinue: forced.some(isFailureDimension),
	};
}

export interface DeriveOutcomeContext {
	nextStage?: string;
	missingFiles?: string[];
}

function correctionMessage(
	id: ReadinessDimensionId,
	context: DeriveOutcomeContext,
): string {
	switch (id) {
		case "continuation_sufficiency":
			return context.missingFiles?.length
				? `File no longer exists: ${context.missingFiles.join(
						", ",
				  )}. Update Active Files before continuing.`
				: "Continuation needs files or context the handoff does not carry.";
		case "next_step_clarity":
			return "Next Minimal Step names no concrete file or action.";
		case "verification_support":
			return "Verification gives no command or result; state the command and its outcome.";
		case "blocking_open_decisions":
			return `Open decision blocks ${
				context.nextStage || "the next stage"
			}; resolve or remove it.`;
		case "history_need":
			return "Correct continuation needs history the handoff does not carry; keep this session (preserve_current_session).";
	}
}

/**
 * Derivation table (requirements): history_need strong -> preserve; any
 * below-threshold dimension or a blocking decision -> improve; otherwise
 * continue. Preserve wins the ordering because it is not an editable
 * correction. Source is inferred from provenance (`deterministic` only when
 * every dimension was forced).
 */
export function deriveOutcome(
	dimensions: ReadinessDimension[],
	context: DeriveOutcomeContext = {},
): ReadinessOutcome {
	const byId = new Map(dimensions.map((entry) => [entry.id, entry]));
	const historyNeed = byId.get("history_need")?.value ?? 0;
	const source: ReadinessSource = dimensions.some((entry) => !entry.forced)
		? "jev"
		: "deterministic";

	const failures: ReadinessDimensionId[] = [];
	for (const id of [
		"continuation_sufficiency",
		"next_step_clarity",
		"verification_support",
	] as const) {
		const entry = byId.get(id);
		if (entry && entry.value < MIN_DIMENSION) failures.push(id);
	}
	const blocking = byId.get("blocking_open_decisions");
	if (blocking && blocking.value >= BLOCKING) {
		failures.push("blocking_open_decisions");
	}

	if (historyNeed >= HISTORY_NEED_STRONG) {
		return {
			verdict: "preserve_current_session",
			source,
			dimensions,
			corrections: [],
			reason:
				"Correct continuation needs history the handoff does not carry; keep this session (preserve_current_session).",
		};
	}

	if (failures.length > 0) {
		const corrections: ReadinessCorrection[] = failures.map((id) => ({
			dimension: id,
			message: correctionMessage(id, context),
		}));
		return { verdict: "improve_handoff", source, dimensions, corrections };
	}

	return { verdict: "continue", source, dimensions, corrections: [] };
}

/** Frozen calibration copy for each `noul` (frozen in the plan's open decisions). */
const QUESTION_COPY: Record<
	ReadinessDimensionId,
	{ instructions: string; true: string; false: string }
> = {
	continuation_sufficiency: {
		instructions:
			"Can a fresh model continue from this handoff without reconstructing major history?",
		true: "The handoff carries enough truth, files, and decisions to continue.",
		false: "Major history or context is missing.",
	},
	next_step_clarity: {
		instructions:
			"Does the Next Minimal Step name a concrete action, file, or command to act on next?",
		true: "It names a specific file, command, or action.",
		false: "It is generic or a bare command.",
	},
	verification_support: {
		instructions:
			"Does the handoff state a verification command and its outcome that a fresh model can trust or re-run?",
		true: "A concrete command and result are stated.",
		false: "No command or result is stated.",
	},
	blocking_open_decisions: {
		instructions:
			"Does at least one open decision block progress into the next stage?",
		true: "At least one open decision must be resolved before the next stage can proceed.",
		false: "Open decisions are non-blocking or absent.",
	},
	history_need: {
		instructions:
			"Does correct continuation require history that this handoff does not carry?",
		true: "Reconstructing it would require history outside the handoff.",
		false: "The handoff is self-contained.",
	},
};

function buildQuestions(
	asked: readonly ReadinessDimensionId[],
): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	for (const id of asked) {
		const copy = QUESTION_COPY[id];
		questions[id] = {
			type: "noul",
			instructions: copy.instructions,
			criteria: { true: copy.true, false: copy.false },
		};
	}
	return questions;
}

function capItems(items: string[]): string[] {
	return items.map((item) =>
		truncateUtf8ToBytes(item, ARRAY_ITEM_BYTES, TRUNCATION_MARKER),
	);
}

function serializeState(state: ReadinessState): Record<string, unknown> {
	const artifacts: Record<string, string> = {};
	for (const [key, value] of Object.entries(state.artifacts)) {
		artifacts[key] = truncateUtf8ToBytes(
			value,
			ARRAY_ITEM_BYTES,
			TRUNCATION_MARKER,
		);
	}
	return {
		currentStage: state.currentStage,
		nextStage: state.nextStage,
		handoffMarkdown: truncateUtf8ToBytes(
			state.handoffMarkdown,
			HANDOFF_MARKDOWN_BYTES,
			TRUNCATION_MARKER,
		),
		currentTask: truncateUtf8ToBytes(
			state.currentTask,
			CURRENT_TASK_BYTES,
			TRUNCATION_MARKER,
		),
		nextMinimalStep: state.nextMinimalStep,
		verification: state.verification,
		blocker: state.blocker,
		openDecisions: [...state.openDecisions],
		currentTruth: capItems(state.currentTruth),
		invalidatedAssumptions: capItems(state.invalidatedAssumptions),
		activeFiles: capItems(state.activeFiles),
		recentlyAccessedFiles: capItems(state.recentlyAccessedFiles),
		artifacts,
		activeRules: capItems(state.activeRules),
	};
}

/** One bounded `decide()` request for the unforced dimensions. */
export function buildReadinessRequest(
	state: ReadinessState,
	asked: readonly ReadinessDimensionId[] = READINESS_QUESTION_IDS,
): JevRequest {
	return { state: serializeState(state), questions: buildQuestions(asked) };
}

const NON_VERDICT_ARRAYS = [
	"currentTruth",
	"invalidatedAssumptions",
	"activeRules",
	"recentlyAccessedFiles",
	"activeFiles",
] as const;

/** UTF-8 byte length without a Node `Buffer` dependency (pure module). */
function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

function requestBodyBytes(request: JevRequest): number {
	try {
		return utf8ByteLength(JSON.stringify(request));
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

type TruncationStep = (state: Record<string, unknown>) => void;

function stringShrinker(key: string, max: number): TruncationStep {
	return (state) => {
		const value = state[key];
		if (typeof value === "string") {
			state[key] = truncateUtf8ToBytes(value, max, TRUNCATION_MARKER);
		}
	};
}

function itemShrinker(key: string, max: number): TruncationStep {
	return (state) => {
		const value = state[key];
		if (Array.isArray(value)) {
			state[key] = value.map((item) =>
				typeof item === "string"
					? truncateUtf8ToBytes(item, max, TRUNCATION_MARKER)
					: item,
			);
		}
	};
}

function arrayClearer(key: string): TruncationStep {
	return (state) => {
		if (Array.isArray(state[key])) state[key] = [];
	};
}

function artifactValueClearer(): TruncationStep {
	return (state) => {
		const artifacts = state.artifacts;
		if (artifacts && typeof artifacts === "object") {
			const record = artifacts as Record<string, unknown>;
			for (const key of Object.keys(record)) record[key] = "";
		}
	};
}

// Ladder order: markdown bulk -> currentTask -> non-verdict array items -> those
// arrays -> verdict-carrying strings last. Built once; each step is state-driven.
const TRUNCATION_LADDER: readonly TruncationStep[] = (() => {
	const steps: TruncationStep[] = [
		stringShrinker("handoffMarkdown", 8_192),
		stringShrinker("handoffMarkdown", 0),
		stringShrinker("currentTask", 1_024),
		stringShrinker("currentTask", 0),
	];
	for (const key of NON_VERDICT_ARRAYS) steps.push(itemShrinker(key, 256));
	for (const key of NON_VERDICT_ARRAYS) steps.push(itemShrinker(key, 0));
	for (const key of NON_VERDICT_ARRAYS) steps.push(arrayClearer(key));
	steps.push(
		stringShrinker("nextMinimalStep", 1_024),
		stringShrinker("verification", 1_024),
		itemShrinker("openDecisions", 1_024),
		stringShrinker("nextMinimalStep", 0),
		stringShrinker("verification", 0),
		itemShrinker("openDecisions", 0),
		stringShrinker("blocker", 0),
		artifactValueClearer(),
	);
	return steps;
})();

/**
 * Truncation ladder (plan Unit 3). Mutates the request and stops as soon as the
 * body is under the cap; never throws.
 */
export function enforceRequestBodyLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const state = request.state as Record<string, unknown>;
	for (const step of TRUNCATION_LADDER) {
		step(state);
		if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	}
}

function isUnitNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

/**
 * Read the unforced `noul` answers, rejecting any partial/low-confidence set as
 * a degraded reason string. Forced dimensions are merged back in frozen order so
 * the derived outcome always sees all five.
 */
export function readAnswers(
	result: JevResult,
	forced: ReadinessDimension[] = [],
): ReadinessDimension[] | string {
	const forcedIds = new Set(forced.map((entry) => entry.id));
	const answered: ReadinessDimension[] = [];
	for (const id of READINESS_QUESTION_IDS) {
		if (forcedIds.has(id)) continue;
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
		answered.push({ id, value: answer.noul, confidence, forced: false });
	}

	const byId = new Map<ReadinessDimensionId, ReadinessDimension>();
	for (const entry of forced) byId.set(entry.id, entry);
	for (const entry of answered) byId.set(entry.id, entry);
	return READINESS_QUESTION_IDS.map((id) => byId.get(id)).filter(
		(entry): entry is ReadinessDimension => entry !== undefined,
	);
}
