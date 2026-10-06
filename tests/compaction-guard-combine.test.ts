// Unit 2 — compaction-guard pure core: frozen questions, request build +
// byte bounding, answer validation, good-boundary derivation, signature hashing.
import { describe, expect, test } from "bun:test";
import {
	COMPACTION_QUESTION_IDS,
	HISTORY_NEED_MAX,
	MEANINGFUL_BOUNDARY_MIN,
	MID_OPERATION_MAX,
	QUESTION_COPY,
	TASK_SWITCH_MIN,
	THRESHOLDS_VERSION,
	buildCompactionRequest,
	buildCompactionState,
	canonicalizeCompactionState,
	deriveAction,
	deriveGoodBoundary,
	deriveOutcome,
	enforceRequestBodyLimit,
	hashCompactionSignature,
	readAnswers,
} from "../extensions/ce-core/compaction-guard/combine.js";
import { MAX_REQUEST_BODY_BYTES, MIN_CONFIDENCE } from "../extensions/ce-core/compaction-guard/facts.js";
import { redactSecrets as utilRedact } from "../extensions/ce-core/utils/redact.js";
import { redactSecrets as driftRedact } from "../extensions/ce-core/drift/combine.js";
import type {
	CompactionDimension,
	CompactionDimensionId,
	CompactionState,
} from "../extensions/ce-core/compaction-guard/types.js";
import type { JevResult } from "../extensions/ce-core/jev/types.js";

const DEFAULTS: Record<CompactionDimensionId, number> = {
	task_switch: 1,
	meaningful_boundary: 1,
	history_need: 0,
	mid_operation: 0,
};

function dims(
	over: Partial<Record<CompactionDimensionId, number>> = {},
): CompactionDimension[] {
	const values = { ...DEFAULTS, ...over };
	return COMPACTION_QUESTION_IDS.map((id) => ({
		id,
		value: values[id],
		confidence: 1,
	}));
}

function jevResult(
	answers: Partial<Record<CompactionDimensionId, unknown>>,
): JevResult {
	const filled: Record<string, unknown> = {};
	for (const id of COMPACTION_QUESTION_IDS) {
		filled[id] = answers[id] ?? {
			type: "noul",
			noul: DEFAULTS[id],
			confidence: 1,
		};
	}
	return { answers: filled as JevResult["answers"], model: "fake", warnings: [] };
}

function state(over: Partial<CompactionState> = {}): CompactionState {
	return {
		isSplitTurn: false,
		recentEntries: [],
		priorSummary: "",
		tokensBefore: 100_000,
		overageTokens: 500,
		pressure: 0.8,
		...over,
	};
}

describe("frozen contract constants", () => {
	test("pins threshold bands, version, and ask order", () => {
		expect(THRESHOLDS_VERSION).toBe(1);
		expect(TASK_SWITCH_MIN).toBe(0.5);
		expect(MEANINGFUL_BOUNDARY_MIN).toBe(0.5);
		expect(HISTORY_NEED_MAX).toBe(0.5);
		expect(MID_OPERATION_MAX).toBe(0.6);
		expect(MIN_CONFIDENCE).toBe(0.5);
		expect(COMPACTION_QUESTION_IDS).toEqual([
			"task_switch",
			"meaningful_boundary",
			"history_need",
			"mid_operation",
		]);
	});

	test("pins the question copy strings", () => {
		expect(QUESTION_COPY.task_switch.true).toContain("task switch");
		expect(QUESTION_COPY.mid_operation.false).toContain("not split");
		expect(QUESTION_COPY.history_need.instructions).toContain("history");
	});
});

describe("shared redactor identity (AD-7)", () => {
	test("drift/combine re-exports the utils/redact implementation", () => {
		expect(driftRedact).toBe(utilRedact);
	});
});

describe("deriveGoodBoundary truth table", () => {
	// boundary = (task_switch >= 0.5 OR meaningful_boundary >= 0.5)
	const rows: Array<[boolean, boolean, boolean, boolean]> = [];
	for (const boundary of [true, false]) {
		for (const historyOk of [true, false]) {
			for (const midOk of [true, false]) {
				rows.push([boundary, historyOk, midOk, boundary && historyOk && midOk]);
			}
		}
	}
	for (const [boundary, historyOk, midOk, expected] of rows) {
		test(`boundary=${boundary} history_ok=${historyOk} mid_ok=${midOk} → ${expected}`, () => {
			const dimensions = dims({
				task_switch: boundary ? 1 : 0,
				meaningful_boundary: 0,
				history_need: historyOk ? 0 : 1,
				mid_operation: midOk ? 0 : 1,
			});
			expect(deriveGoodBoundary(dimensions)).toBe(expected);
			expect(deriveAction(dimensions)).toBe(expected ? "allow" : "defer");
		});
	}

	test("a meaningful_boundary alone satisfies the boundary clause", () => {
		expect(
			deriveGoodBoundary(
				dims({ task_switch: 0, meaningful_boundary: 0.5 }),
			),
		).toBe(true);
	});

	test("boundaries are inclusive at their thresholds", () => {
		expect(
			deriveGoodBoundary(
				dims({ history_need: HISTORY_NEED_MAX, mid_operation: 0 }),
			),
		).toBe(false);
		expect(
			deriveGoodBoundary(
				dims({ history_need: 0, mid_operation: MID_OPERATION_MAX }),
			),
		).toBe(false);
	});

	test("deriveOutcome keeps jev provenance and the dimensions", () => {
		const outcome = deriveOutcome(dims({ task_switch: 0, meaningful_boundary: 0 }));
		expect(outcome.action).toBe("defer");
		expect(outcome.source).toBe("jev");
		expect(outcome.dimensions).toHaveLength(4);
	});
});

describe("readAnswers", () => {
	test("accepts a complete valid answer set", () => {
		expect(Array.isArray(readAnswers(jevResult({})))).toBe(true);
	});

	test("rejects a missing dimension with a reason", () => {
		const result = jevResult({});
		delete (result.answers as Record<string, unknown>).mid_operation;
		const parsed = readAnswers(result);
		expect(parsed as string).toContain("mid_operation");
	});

	test("rejects a confidence below the floor", () => {
		const parsed = readAnswers(
			jevResult({ mid_operation: { type: "noul", noul: 0.9, confidence: 0.4 } }),
		);
		expect(typeof parsed).toBe("string");
	});

	test("rejects out-of-range and non-finite values", () => {
		expect(
			readAnswers(
				jevResult({ mid_operation: { type: "noul", noul: 1.4 } }),
			) as string,
		).toContain("mid_operation");
		expect(
			readAnswers(
				jevResult({ mid_operation: { type: "noul", noul: Number.NaN } }),
			) as string,
		).toContain("mid_operation");
	});

	test("returns dimensions in ask order", () => {
		const parsed = readAnswers(jevResult({})) as CompactionDimension[];
		expect(parsed.map((dimension) => dimension.id)).toEqual([
			...COMPACTION_QUESTION_IDS,
		]);
	});
});

describe("signature stability", () => {
	test("is stable when pressure/overage/tokensBefore change", () => {
		const base = state();
		const changed = state({
			tokensBefore: 999_999,
			overageTokens: -10_000,
			pressure: 0.01,
		});
		expect(hashCompactionSignature(base)).toBe(hashCompactionSignature(changed));
	});

	test("changes when recentEntries, priorSummary, or isSplitTurn change", () => {
		const base = state({ recentEntries: ["a"] });
		expect(hashCompactionSignature(base)).not.toBe(
			hashCompactionSignature(state({ recentEntries: ["b"] })),
		);
		expect(hashCompactionSignature(base)).not.toBe(
			hashCompactionSignature(state({ recentEntries: ["a"], priorSummary: "x" })),
		);
		expect(hashCompactionSignature(base)).not.toBe(
			hashCompactionSignature(
				state({ recentEntries: ["a"], isSplitTurn: true }),
			),
		);
	});

	test("canonicalizeCompactionState excludes volatile fields", () => {
		const canonical = canonicalizeCompactionState(state());
		expect(canonical).not.toContain("pressure");
		expect(canonical).not.toContain("tokensBefore");
		expect(() => JSON.parse(canonical)).not.toThrow();
	});
});

describe("buildCompactionRequest + enforceRequestBodyLimit", () => {
	test("asks all four dimensions with their pinned copy", () => {
		const request = buildCompactionRequest(
			buildCompactionState({ facts: { reason: "threshold", tokensBefore: 1, contextWindow: 100, triggerTokens: 90, headroomTokens: 10, overageTokens: 1, pressure: 0.01, tier: "silent" }, isSplitTurn: true, recentEntries: ["x"], priorSummary: "y" }),
		);
		expect(Object.keys(request.questions)).toEqual([...COMPACTION_QUESTION_IDS]);
		expect((request.questions.task_switch as { type: string }).type).toBe("noul");
	});

	test("redacts and truncates entries before egress", () => {
		const built = buildCompactionState({
			facts: { reason: "threshold", tokensBefore: 1, contextWindow: 100, triggerTokens: 90, headroomTokens: 10, overageTokens: 1, pressure: 0.01, tier: "silent" },
			recentEntries: ["API_TOKEN=abc123", "x".repeat(10_000)],
		});
		const request = buildCompactionRequest(built);
		const payload = request.state as { recentEntries: string[] };
		expect(payload.recentEntries[0]).toBe("API_TOKEN=[redacted]");
		expect(payload.recentEntries[1].length).toBeLessThan(10_000);
	});

	test("bounds a pathological state under MAX_REQUEST_BODY_BYTES", () => {
		const request = buildCompactionRequest(
			state({
				recentEntries: Array.from({ length: 50 }, () => "x".repeat(100_000)),
				priorSummary: "y".repeat(100_000),
			}),
		);
		enforceRequestBodyLimit(request);
		expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(
			MAX_REQUEST_BODY_BYTES,
		);
	});

	test("never throws on a malformed state", () => {
		const request = buildCompactionRequest(state());
		(request as { state: unknown }).state = null;
		expect(() => enforceRequestBodyLimit(request)).not.toThrow();
	});
});
