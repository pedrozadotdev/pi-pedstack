// Docs verification — pure combination logic (plan Unit 3). No I/O.
// Thresholds, frozen question copy, the byte-bounded request builder, the
// decision table, and obligation construction all live here.
import type { JevQuestion, JevRequest, JevResult } from "../jev/types";
import { truncateUtf8ToBytes } from "../utils/solution-recall";
import type {
	DocsAnswers,
	DocsDecision,
	DocsObligation,
	DocsQuestionId,
	DocsUnit,
	DocsUnitRecord,
	EvidenceFact,
	PackageFact,
	UnitFacts,
} from "./types";

export const THRESHOLDS_VERSION = 1;
export const EVIDENCE_GRAMMAR = 1;
/** Value threshold compared to a `noul` value. */
const MIN_SIGNAL = 0.5;
/** Confidence floor applied to every Jev answer (not a value threshold). */
const MIN_CONFIDENCE = 0.5;
export const PACKAGE_CAP = 8;
export const MAX_UNITS = 40;
export const DOCS_JEV_TIMEOUT_MS = 8_000;
export const MAX_REQUEST_BODY_BYTES = 65_536;
const MAX_UNIT_TEXT_BYTES = 2_048;
const TRUNCATION_MARKER = "…[truncated]";

/** The three frozen question ids, in ask order. */
export const DOCS_QUESTION_IDS: readonly DocsQuestionId[] = [
	"external_api_dependence",
	"version_sensitivity",
	"verification_material",
];

const DECISIONS = new Set<DocsDecision>([
	"not_required",
	"required",
	"uncertain",
]);

/** Parses a persisted/derived decision string; anything else is uncertain. */
export function deriveDecisionFromString(value: string): DocsDecision {
	return DECISIONS.has(value as DocsDecision)
		? (value as DocsDecision)
		: "uncertain";
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
 * Ordered, capped package names for one unit: sorted by first appearance then
 * name. `truncated` means the cap was exceeded (R4).
 */
export function aggregatePackages(facts: UnitFacts): {
	names: string[];
	truncated: boolean;
} {
	const order = new Map<string, number>();
	for (const fact of facts.packages) {
		if (!order.has(fact.name)) order.set(fact.name, order.size);
	}
	const ordered = [...order.keys()].sort((a, b) => {
		const delta = (order.get(a) ?? 0) - (order.get(b) ?? 0);
		return delta !== 0 ? delta : a < b ? -1 : a > b ? 1 : 0;
	});
	return {
		names: ordered.slice(0, PACKAGE_CAP),
		truncated: ordered.length > PACKAGE_CAP,
	};
}

function decisionTable(answers: DocsAnswers): DocsDecision {
	const external = answers.external_api_dependence >= MIN_SIGNAL;
	const version = answers.version_sensitivity >= MIN_SIGNAL;
	const material = answers.verification_material >= MIN_SIGNAL;
	if (external && (version || material)) return "required";
	if (!external && !material) return "not_required";
	return "uncertain";
}

/**
 * Deterministic short-circuit before any Jev call. Returns `null` when the unit
 * must be scored. An observed unit with no external facts is `not_required`; a
 * planned greenfield unit whose declared files do not exist is `uncertain` (R4).
 */
export function shortCircuitDecision(facts: UnitFacts): DocsDecision | null {
	if (facts.packages.length > 0) return null;
	if (facts.phase === "planned" && facts.declaredFiles.some((file) => !file.exists)) {
		return "uncertain";
	}
	return "not_required";
}

/**
 * Maps bounded `noul` answers plus deterministic facts to exactly one decision:
 * package cap first, then the table, then the version-unknown floor (R4).
 */
export function deriveDecision(
	answers: DocsAnswers,
	facts: UnitFacts,
): DocsDecision {
	if (facts.packages.length === 0) return "not_required";
	if (aggregatePackages(facts).truncated) return "uncertain";
	const base = decisionTable(answers);
	if (base === "not_required" && facts.versionUnknown) return "uncertain";
	return base;
}

/** `slug__questionId`, the request key for one unit's one judgment. */
function answerKey(slug: string, id: DocsQuestionId): string {
	return `${slug}__${id}`;
}

/** Read one unit's answer set; any missing/invalid answer is a reason string. */
export function readDocsAnswers(
	result: JevResult,
	slug: string,
): DocsAnswers | string {
	const out: Partial<DocsAnswers> = {};
	for (const id of DOCS_QUESTION_IDS) {
		const answer = result.answers?.[answerKey(slug, id)];
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
		out[id] = answer.noul;
	}
	return out as DocsAnswers;
}

/** Frozen calibration copy for each `noul`. */
const QUESTION_COPY: Record<
	DocsQuestionId,
	{ instructions: string; true: string; false: string }
> = {
	external_api_dependence: {
		instructions:
			"Does this unit's behavior depend on the API of an external package rather than on in-repo logic?",
		true: "The unit relies on an externally-installed package's API.",
		false: "The behavior is implemented in-repo.",
	},
	version_sensitivity: {
		instructions:
			"Is correctness sensitive to which version of that package is installed?",
		true: "A different installed version would change behavior or correctness.",
		false: "Any compatible version behaves the same.",
	},
	verification_material: {
		instructions:
			"Would authoritative package documentation materially reduce the risk of getting this unit wrong?",
		true: "Authoritative docs would prevent a likely mistake.",
		false: "In-repo knowledge already covers it.",
	},
};

function buildQuestions(slug: string): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	for (const id of DOCS_QUESTION_IDS) {
		const copy = QUESTION_COPY[id];
		questions[answerKey(slug, id)] = {
			type: "noul",
			instructions: copy.instructions,
			criteria: { true: copy.true, false: copy.false },
		};
	}
	return questions;
}

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

/**
 * One bounded `decide()` request for every scorable unit. Unit text is wrapped
 * verbatim as data and truncated; it is never interpreted as instructions (R3).
 */
export function buildDocsRequest(
	units: DocsUnit[],
	facts: Map<DocsUnit, UnitFacts>,
): JevRequest {
	const scorable = units.slice(0, MAX_UNITS);
	const state = {
		units: scorable.map((unit) => ({
			slug: unit.slug,
			heading: unit.heading,
			packages: aggregatePackages(
				facts.get(unit) ?? {
					phase: "observed",
					declaredFiles: [],
					packages: [],
					evidence: [],
					versionUnknown: false,
				},
			).names,
			text: truncateUtf8ToBytes(
				unit.text,
				MAX_UNIT_TEXT_BYTES,
				TRUNCATION_MARKER,
			),
		})),
	};
	const questions: Record<string, JevQuestion> = {};
	for (const unit of scorable) {
		Object.assign(questions, buildQuestions(unit.slug));
	}
	return { state, questions };
}

interface MutableUnitState {
	text?: unknown;
	packages?: unknown;
}

function unitStates(request: JevRequest): MutableUnitState[] {
	const state = request.state as { units?: unknown };
	return Array.isArray(state.units) ? (state.units as MutableUnitState[]) : [];
}

// Ladder: shrink unit text -> empty unit text -> drop package lists. The
// question set is never mutated (the verdict always needs its answers).
const TRUNCATION_LADDER: ReadonlyArray<(units: MutableUnitState[]) => void> = [
	(units) => {
		for (const unit of units) {
			if (typeof unit.text === "string") {
				unit.text = truncateUtf8ToBytes(unit.text, 512, TRUNCATION_MARKER);
			}
		}
	},
	(units) => {
		for (const unit of units) {
			if (typeof unit.text === "string") {
				unit.text = truncateUtf8ToBytes(unit.text, 0, TRUNCATION_MARKER);
			}
		}
	},
	(units) => {
		for (const unit of units) unit.packages = [];
	},
];

/** Truncation ladder; mutates the request and stops as soon as it fits. */
export function enforceRequestBodyLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const units = unitStates(request);
	for (const step of TRUNCATION_LADDER) {
		step(units);
		if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	}
}

/** Construct the tracked obligation for one unit (R5). */
export function buildObligation(
	record: Omit<DocsUnitRecord, "obligation">,
	now: () => Date = () => new Date(),
): DocsObligation {
	const evidence = (record.facts.evidence[0] ?? undefined) as
		| EvidenceFact
		| undefined;
	return {
		slug: record.slug,
		status: record.decision === "not_required" ? "satisfied" : "open",
		decision: record.decision,
		packages: [...record.packages],
		source: record.source,
		...(record.reason ? { reason: record.reason } : {}),
		...(evidence ? { evidence } : {}),
		updatedAt: now().toISOString(),
	};
}

/** Convenience for callers that need only the package names touched. */
export function packageNames(facts: UnitFacts): string[] {
	return aggregatePackages(facts).names;
}
