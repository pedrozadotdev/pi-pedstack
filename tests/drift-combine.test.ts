// Unit 2 — drift pure core: thresholds, question copy, request build,
// answer validation, verdict/streak derivation, hashing, redaction.
import { describe, expect, test } from "bun:test";
import {
	ACTION_REASON_BYTES,
	ACTION_TARGET_BYTES,
	DRIFT_CLEAR_STREAK,
	DRIFT_QUESTION_IDS,
	EXCERPT_BYTES,
	FORBIDDEN_STRONG,
	IN_SCOPE_MIN,
	MAX_REQUEST_BODY_BYTES,
	MILD_REPEAT_LIMIT,
	MIN_CONFIDENCE,
	PROGRESS_MIN,
	QUESTION_COPY,
	SCOPE_DRIFT_STRONG,
	THRESHOLDS_VERSION,
	buildDriftRequest,
	canonicalizeTurnState,
	correctionMessage,
	deriveVerdict,
	enforceRequestBodyLimit,
	hashTurnSignature,
	readAnswers,
	redactSecrets,
	truncateToBytes,
} from "../extensions/ce-core/drift/combine.js";
import type {
	DriftDimension,
	DriftDimensionId,
	DriftTurnState,
} from "../extensions/ce-core/drift/types.js";
import type { JevResult } from "../extensions/ce-core/jev/types";

const DEFAULTS: Record<DriftDimensionId, number> = {
	in_stage_scope: 1,
	forbidden_work: 0,
	scope_drift: 0,
	progress: 1,
};

function dims(over: Partial<Record<DriftDimensionId, number>> = {}): DriftDimension[] {
	const values = { ...DEFAULTS, ...over };
	return DRIFT_QUESTION_IDS.map((id) => ({
		id,
		value: values[id],
		confidence: 1,
	}));
}

function jevResult(
	answers: Partial<Record<DriftDimensionId, unknown>>,
): JevResult {
	const filled: Record<string, unknown> = {};
	for (const id of DRIFT_QUESTION_IDS) {
		filled[id] = answers[id] ?? {
			type: "noul",
			noul: DEFAULTS[id],
			confidence: 1,
		};
	}
	return {
		answers: filled as JevResult["answers"],
		model: "fake",
		warnings: [],
	};
}

function turnState(over: Partial<DriftTurnState> = {}): DriftTurnState {
	return {
		stage: "02-plan",
		mandate: "plan",
		forbidden: "no source",
		actions: [],
		assistantExcerpt: "",
		wroteStageArtifact: false,
		...over,
	};
}

function bytes(text: string): number {
	return Buffer.byteLength(JSON.stringify({ state: text }), "utf8");
}

describe("frozen contract constants", () => {
	test("pins thresholds and ask order", () => {
		expect(THRESHOLDS_VERSION).toBe(1);
		expect(MIN_CONFIDENCE).toBe(0.5);
		expect(IN_SCOPE_MIN).toBe(0.5);
		expect(SCOPE_DRIFT_STRONG).toBe(0.6);
		expect(PROGRESS_MIN).toBe(0.5);
		expect(MILD_REPEAT_LIMIT).toBe(2);
		expect(FORBIDDEN_STRONG).toBe(0.6);
		expect(DRIFT_QUESTION_IDS).toEqual([
			"in_stage_scope",
			"forbidden_work",
			"scope_drift",
			"progress",
		]);
	});

	test("pins the question copy strings", () => {
		expect(QUESTION_COPY.in_stage_scope.true).toBe(
			"The turn advances the stage's stated mandate.",
		);
		expect(QUESTION_COPY.forbidden_work.instructions).toContain(
			"policy forbids",
		);
		expect(QUESTION_COPY.scope_drift.true).toBe(
			"The turn changed or expanded scope that was not previously approved.",
		);
		expect(QUESTION_COPY.progress.false).toBe(
			"The turn stalled, looped, or produced nothing.",
		);
	});
});

describe("deriveVerdict truth table", () => {
	test("all dimensions in scope → no_drift", () => {
		const derived = deriveVerdict(dims());
		expect(derived.verdict).toBe("no_drift");
		expect(derived.triggered).toEqual([]);
	});

	test("exactly one soft signal → mild_drift", () => {
		const derived = deriveVerdict(dims({ in_stage_scope: 0.1 }));
		expect(derived.verdict).toBe("mild_drift");
		expect(derived.triggered).toEqual(["in_stage_scope"]);
	});

	test("two soft signals → strong_drift", () => {
		const derived = deriveVerdict(
			dims({ in_stage_scope: 0.1, progress: 0.1 }),
		);
		expect(derived.verdict).toBe("strong_drift");
		expect(derived.triggered).toEqual(["in_stage_scope", "progress"]);
	});

	test("forbidden_work >= FORBIDDEN_STRONG alone → strong_drift", () => {
		const derived = deriveVerdict(dims({ forbidden_work: 0.6 }));
		expect(derived.verdict).toBe("strong_drift");
		expect(derived.triggered).toEqual(["forbidden_work"]);
	});

	test("discriminating correlation row: forbidden below threshold is not counted twice", () => {
		const derived = deriveVerdict(
			dims({ forbidden_work: 0.59, in_stage_scope: 0.1 }),
		);
		expect(derived.verdict).toBe("mild_drift");
		expect(derived.triggered).toEqual(["in_stage_scope"]);
	});

	test("mild with priorConsecutiveMild >= 1 escalates to strong_drift", () => {
		const derived = deriveVerdict(dims({ in_stage_scope: 0.1 }), {
			priorConsecutiveMild: 1,
		});
		expect(derived.verdict).toBe("strong_drift");
	});

	test("mild with priorConsecutiveMild 0 stays mild", () => {
		expect(
			deriveVerdict(dims({ in_stage_scope: 0.1 }), {
				priorConsecutiveMild: 0,
			}).verdict,
		).toBe("mild_drift");
	});
});

describe("deriveVerdict counters and clear rule", () => {
	test("no_drift increments consecutiveNoDrift and zeroes mild", () => {
		const derived = deriveVerdict(dims(), { priorConsecutiveNoDrift: 2 });
		expect(derived.verdict).toBe("no_drift");
		expect(derived.consecutiveNoDrift).toBe(3);
		expect(derived.consecutiveMild).toBe(0);
	});

	test("mild starts the consecutiveMild streak and zeroes noDrift", () => {
		const derived = deriveVerdict(dims({ progress: 0.1 }), {
			priorConsecutiveMild: 0,
			priorConsecutiveNoDrift: 5,
		});
		expect(derived.consecutiveMild).toBe(1);
		expect(derived.consecutiveNoDrift).toBe(0);
	});

	test("strong zeroes both counters", () => {
		const derived = deriveVerdict(dims({ forbidden_work: 0.9 }), {
			priorConsecutiveMild: 3,
			priorConsecutiveNoDrift: 3,
		});
		expect(derived.consecutiveMild).toBe(0);
		expect(derived.consecutiveNoDrift).toBe(0);
	});

	test("strong prior + no_drift without artifact stays strong at 1", () => {
		const derived = deriveVerdict(dims(), {
			priorVerdict: "strong_drift",
			priorConsecutiveNoDrift: 0,
			wroteStageArtifact: false,
		});
		expect(derived.verdict).toBe("strong_drift");
		expect(derived.consecutiveNoDrift).toBe(1);
	});

	test("strong prior + no_drift with wroteStageArtifact clears in one turn", () => {
		const derived = deriveVerdict(dims(), {
			priorVerdict: "strong_drift",
			priorConsecutiveNoDrift: 0,
			wroteStageArtifact: true,
		});
		expect(derived.verdict).toBe("no_drift");
	});

	test("strong prior + no_drift clears once consecutiveNoDrift reaches the streak", () => {
		const derived = deriveVerdict(dims(), {
			priorVerdict: "strong_drift",
			priorConsecutiveNoDrift: DRIFT_CLEAR_STREAK - 1,
			wroteStageArtifact: false,
		});
		expect(derived.verdict).toBe("no_drift");
	});

	test("strong prior + a fresh strong signal stays strong", () => {
		const derived = deriveVerdict(dims({ forbidden_work: 0.8 }), {
			priorVerdict: "strong_drift",
			priorConsecutiveNoDrift: 1,
		});
		expect(derived.verdict).toBe("strong_drift");
		expect(derived.consecutiveNoDrift).toBe(0);
	});
});

describe("readAnswers", () => {
	test("accepts a complete valid answer set", () => {
		const parsed = readAnswers(jevResult({}));
		expect(Array.isArray(parsed)).toBe(true);
	});

	test("rejects a missing dimension with a reason", () => {
		const result = jevResult({});
		delete (result.answers as Record<string, unknown>).progress;
		const parsed = readAnswers(result);
		expect(typeof parsed).toBe("string");
		expect(parsed as string).toContain("progress");
	});

	test("rejects a confidence below the floor", () => {
		const parsed = readAnswers(
			jevResult({
				progress: { type: "noul", noul: 0.9, confidence: 0.4 },
			}),
		);
		expect(typeof parsed).toBe("string");
	});

	test("defaults an absent confidence to 1", () => {
		const parsed = readAnswers(
			jevResult({ progress: { type: "noul", noul: 0.9 } }),
		);
		expect(Array.isArray(parsed)).toBe(true);
		const entry = (parsed as DriftDimension[]).find(
			(dimension) => dimension.id === "progress",
		);
		expect(entry?.confidence).toBe(1);
	});

	test("rejects out-of-range and non-finite values", () => {
		expect(
			readAnswers(
				jevResult({ progress: { type: "noul", noul: 1.1 } }),
			) as string,
		).toContain("progress");
		expect(
			readAnswers(
				jevResult({ progress: { type: "noul", noul: Number.NaN } }),
			) as string,
		).toContain("progress");
	});

	test("rejects a non-noul answer", () => {
		const parsed = readAnswers(
			jevResult({
				progress: { type: "choice", choice: "x", probabilities: {}, confidence: 1 },
			}),
		);
		expect(typeof parsed).toBe("string");
	});

	test("returns dimensions in ask order", () => {
		const parsed = readAnswers(jevResult({})) as DriftDimension[];
		expect(parsed.map((dimension) => dimension.id)).toEqual([
			...DRIFT_QUESTION_IDS,
		]);
	});
});

describe("buildDriftRequest + enforceRequestBodyLimit", () => {
	test("asks all four dimensions with their pinned copy", () => {
		const request = buildDriftRequest(turnState());
		expect(Object.keys(request.questions)).toEqual([...DRIFT_QUESTION_IDS]);
		expect(
			(request.questions.in_stage_scope as { type: string }).type,
		).toBe("noul");
	});

	test("bounds a pathological excerpt under MAX_REQUEST_BODY_BYTES", () => {
		const request = buildDriftRequest(
			turnState({ assistantExcerpt: "x".repeat(100_000) }),
		);
		enforceRequestBodyLimit(request);
		expect(bytes(JSON.stringify(request))).toBeLessThanOrEqual(
			MAX_REQUEST_BODY_BYTES,
		);
	});

	test("never throws on a malformed state", () => {
		const request = buildDriftRequest(turnState());
		(request as { state: unknown }).state = null;
		expect(() => enforceRequestBodyLimit(request)).not.toThrow();
	});
});

describe("signature hashing", () => {
	test("is stable for reordered object keys", () => {
		const a = turnState({
			stage: "02-plan",
			actions: [
				{ tool: "read", effect: "read_only", target: "a.ts", error: false },
			],
		});
		const b = turnState({
			actions: [
				{ error: false, target: "a.ts", effect: "read_only", tool: "read" },
			],
			stage: "02-plan",
		});
		expect(hashTurnSignature(a)).toBe(hashTurnSignature(b));
	});

	test("changes when the action set changes", () => {
		const a = turnState();
		const b = turnState({
			actions: [
				{ tool: "bash", effect: "mutates_workspace", target: "x", error: false },
			],
		});
		expect(hashTurnSignature(a)).not.toBe(hashTurnSignature(b));
	});

	test("canonicalizeTurnState is JSON", () => {
		expect(() => JSON.parse(canonicalizeTurnState(turnState()))).not.toThrow();
	});
});

describe("redactSecrets", () => {
	test("redacts credential assignments", () => {
		expect(redactSecrets("API_TOKEN=abc123 end")).toBe(
			"API_TOKEN=[redacted] end",
		);
		expect(redactSecrets("MY_KEY=zzz")).toBe("MY_KEY=[redacted]");
	});

	test("strips URL query and fragment", () => {
		const redacted = redactSecrets("see https://x.test/a?token=z#frag now");
		expect(redacted).not.toContain("token=z");
		expect(redacted).not.toContain("#frag");
	});
});

describe("truncateToBytes + correctionMessage", () => {
	test("truncateToBytes leaves short text and caps long text", () => {
		expect(truncateToBytes("short", 100)).toBe("short");
		expect(Buffer.byteLength(truncateToBytes("x".repeat(500), 100))).toBeLessThanOrEqual(
			100 + Buffer.byteLength("…[truncated]"),
		);
	});

	test("correctionMessage names the stage and dimension intent", () => {
		expect(correctionMessage("in_stage_scope", "02-plan")).toContain("02-plan");
		expect(correctionMessage("progress", "03-work")).toContain("03-work");
	});
});

describe("byte-cap constants stay frozen", () => {
	test("pins the caps used by the request ladder", () => {
		expect(EXCERPT_BYTES).toBe(1024);
		expect(ACTION_TARGET_BYTES).toBe(160);
		expect(ACTION_REASON_BYTES).toBe(200);
	});
});
