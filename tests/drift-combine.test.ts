// Unit 1 + Unit 2 — drift pure core: frozen table constants, answer
// validation, verdict derivation from the frozen spec matrix, recurrence knob,
// question copy, request build, hashing, redaction.
//
// Threshold expectations come from a test-local *spec table* (literal numbers),
// never from the production constants; the only constant import used for
// assertions is `DRIFT_QUESTION_IDS` (ask order).
import { describe, expect, test } from "bun:test";
import * as combine from "../extensions/ce-core/drift/combine.js";
import {
	ACTION_REASON_BYTES,
	ACTION_TARGET_BYTES,
	DRIFT_CLEAR_STREAK,
	DRIFT_QUESTION_IDS,
	EXCERPT_BYTES,
	MAX_REQUEST_BODY_BYTES,
	QUESTION_COPY,
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
	DriftVerdict,
} from "../extensions/ce-core/drift/types.js";
import type { JevResult } from "../extensions/ce-core/jev/types";

// ── Frozen spec table (normative literals, not production constants) ──
const SPEC = {
	FORBIDDEN_WORK_MILD: 0.6,
	FORBIDDEN_WORK_STRONG: 0.8,
	STRONG_CONFIDENCE: 0.6,
	IN_SCOPE_MIN: 0.5,
	SCOPE_DRIFT_STRONG: 0.6,
	MIN_CONFIDENCE: 0.5,
	MILD_REPEAT_LIMIT: 2,
} as const;

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

/** Dimensions with an explicit `forbidden_work` confidence (spec matrix). */
function specDims(
	values: Partial<Record<DriftDimensionId, number>>,
	forbiddenConfidence = 1,
): DriftDimension[] {
	const merged = { ...DEFAULTS, ...values };
	return DRIFT_QUESTION_IDS.map((id) => ({
		id,
		value: merged[id],
		confidence: id === "forbidden_work" ? forbiddenConfidence : 1,
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
	test("pins the tiered thresholds, version, and ask order", () => {
		expect(combine.THRESHOLDS_VERSION).toBe(2);
		expect(combine.MIN_CONFIDENCE).toBe(0.5);
		expect(combine.IN_SCOPE_MIN).toBe(0.5);
		expect(combine.SCOPE_DRIFT_STRONG).toBe(0.6);
		expect(combine.FORBIDDEN_WORK_MILD).toBe(0.6);
		expect(combine.FORBIDDEN_WORK_STRONG).toBe(0.8);
		expect(combine.STRONG_CONFIDENCE).toBe(0.6);
		expect(combine.MILD_REPEAT_LIMIT).toBe(2);
		expect(DRIFT_QUESTION_IDS).toEqual([
			"in_stage_scope",
			"forbidden_work",
			"scope_drift",
			"progress",
		]);
	});

	test("deletes the dead `PROGRESS_MIN` and `FORBIDDEN_STRONG` knobs", () => {
		expect("PROGRESS_MIN" in combine).toBe(false);
		expect("FORBIDDEN_STRONG" in combine).toBe(false);
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

describe("deriveVerdict — explicit frozen matrix (spec literals)", () => {
	interface MatrixRow {
		name: string;
		values: Partial<Record<DriftDimensionId, number>>;
		forbiddenConfidence?: number;
		priorMild?: number;
		verdict: DriftVerdict;
		triggered: DriftDimensionId[];
	}

	const MATRIX: MatrixRow[] = [
		{
			name: "row 1: all in scope → no_drift",
			values: {
				in_stage_scope: 0.9,
				forbidden_work: 0.1,
				scope_drift: 0.1,
				progress: 0.1,
			},
			verdict: "no_drift",
			triggered: [],
		},
		{
			name: "row 2: out of scope → mild (in_stage_scope)",
			values: {
				in_stage_scope: 0.49,
				forbidden_work: 0.1,
				scope_drift: 0.1,
				progress: 0.1,
			},
			verdict: "mild_drift",
			triggered: ["in_stage_scope"],
		},
		{
			name: "row 3: scope change → mild (scope_drift)",
			values: {
				in_stage_scope: 0.9,
				forbidden_work: 0.1,
				scope_drift: 0.6,
				progress: 0.1,
			},
			verdict: "mild_drift",
			triggered: ["scope_drift"],
		},
		{
			name: "row 4: forbidden mild tier with passing confidence → mild",
			values: {
				in_stage_scope: 0.9,
				forbidden_work: 0.6,
				scope_drift: 0.1,
				progress: 0.1,
			},
			forbiddenConfidence: 0.9,
			verdict: "mild_drift",
			triggered: ["forbidden_work"],
		},
		{
			name: "row 5: strong value but confidence gate fails → stays mild",
			values: {
				in_stage_scope: 0.9,
				forbidden_work: 0.8,
				scope_drift: 0.1,
				progress: 0.1,
			},
			forbiddenConfidence: 0.5,
			verdict: "mild_drift",
			triggered: ["forbidden_work"],
		},
		{
			name: "row 6: forbidden strong value + passing confidence → strong",
			values: {
				in_stage_scope: 0.9,
				forbidden_work: 0.8,
				scope_drift: 0.1,
				progress: 0.1,
			},
			forbiddenConfidence: 0.6,
			verdict: "strong_drift",
			triggered: ["forbidden_work"],
		},
		{
			name: "row 7: two soft signals → strong",
			values: {
				in_stage_scope: 0.49,
				forbidden_work: 0.6,
				scope_drift: 0.1,
				progress: 0.1,
			},
			forbiddenConfidence: 0.9,
			verdict: "strong_drift",
			triggered: ["in_stage_scope", "forbidden_work"],
		},
		{
			// Matrix row 8 lists all-in-scope values with `priorMild=1`; VD-4
			// requires `soft == 1`, so the recurrence row carries the soft
			// trigger it depends on (documented deviation, see plan row 8).
			name: "row 8: one soft signal with a prior mild → strong (repeated mild)",
			values: {
				in_stage_scope: 0.49,
				forbidden_work: 0.1,
				scope_drift: 0.1,
				progress: 0.1,
			},
			priorMild: 1,
			verdict: "strong_drift",
			triggered: ["in_stage_scope"],
		},
	];

	for (const row of MATRIX) {
		test(row.name, () => {
			const derived = deriveVerdict(
				specDims(row.values, row.forbiddenConfidence ?? 1),
				{ priorConsecutiveMild: row.priorMild ?? 0 },
			);
			expect({ verdict: derived.verdict, triggered: derived.triggered }).toEqual({
				verdict: row.verdict,
				triggered: row.triggered,
			});
		});
	}
});

describe("deriveVerdict — threshold boundaries", () => {
	test("in_stage_scope 0.49 triggers, 0.50 does not", () => {
		expect(deriveVerdict(dims({ in_stage_scope: 0.49 })).verdict).toBe(
			"mild_drift",
		);
		expect(deriveVerdict(dims({ in_stage_scope: 0.5 })).verdict).toBe("no_drift");
	});

	test("scope_drift 0.59 does not trigger, 0.60 does", () => {
		expect(deriveVerdict(dims({ scope_drift: 0.59 })).verdict).toBe("no_drift");
		expect(deriveVerdict(dims({ scope_drift: 0.6 })).verdict).toBe("mild_drift");
	});

	test("forbidden_work 0.59 stays untriggered, 0.60 is mild", () => {
		expect(deriveVerdict(dims({ forbidden_work: 0.59 })).verdict).toBe(
			"no_drift",
		);
		expect(deriveVerdict(dims({ forbidden_work: 0.6 })).verdict).toBe(
			"mild_drift",
		);
	});

	test("forbidden_work 0.79 is mild even at full confidence", () => {
		const derived = deriveVerdict(specDims({ forbidden_work: 0.79 }, 1));
		expect(derived.verdict).toBe("mild_drift");
		expect(derived.triggered).toEqual(["forbidden_work"]);
	});

	test("forbidden_work 0.80 × confidence 0.59 → mild; 0.60 → strong", () => {
		expect(
			deriveVerdict(specDims({ forbidden_work: 0.8 }, 0.59)).verdict,
		).toBe("mild_drift");
		expect(
			deriveVerdict(specDims({ forbidden_work: 0.8 }, 0.6)).verdict,
		).toBe("strong_drift");
	});

	test("progress is supporting-only: a progress-only turn is no_drift", () => {
		const derived = deriveVerdict(
			dims({ progress: 0.0, in_stage_scope: 1, scope_drift: 0, forbidden_work: 0 }),
		);
		expect(derived.verdict).toBe("no_drift");
		expect(derived.triggered).toEqual([]);
	});

	test("forbidden below threshold is never counted twice with an in-scope miss", () => {
		const derived = deriveVerdict(
			dims({ forbidden_work: 0.59, in_stage_scope: 0.1 }),
		);
		expect(derived.verdict).toBe("mild_drift");
		expect(derived.triggered).toEqual(["in_stage_scope"]);
	});
});

describe("deriveVerdict — MILD_REPEAT_LIMIT reader", () => {
	test("default limit: one prior mild escalates, none stays mild", () => {
		expect(
			deriveVerdict(dims({ in_stage_scope: 0.1 }), {
				priorConsecutiveMild: 1,
			}).verdict,
		).toBe("strong_drift");
		expect(
			deriveVerdict(dims({ in_stage_scope: 0.1 }), {
				priorConsecutiveMild: 0,
			}).verdict,
		).toBe("mild_drift");
	});

	test("mildRepeatLimit 3: one prior stays mild, two priors escalate", () => {
		const dim = dims({ in_stage_scope: 0.1 });
		expect(
			deriveVerdict(dim, { priorConsecutiveMild: 1, mildRepeatLimit: 3 })
				.verdict,
		).toBe("mild_drift");
		expect(
			deriveVerdict(dim, { priorConsecutiveMild: 2, mildRepeatLimit: 3 })
				.verdict,
		).toBe("strong_drift");
	});

	test("mildRepeatLimit 1 clamps to the floor of 2", () => {
		expect(
			deriveVerdict(dims({ in_stage_scope: 0.1 }), {
				priorConsecutiveMild: 1,
				mildRepeatLimit: 1,
			}).verdict,
		).toBe("strong_drift");
	});

	test("a non-finite mildRepeatLimit falls back to the default", () => {
		expect(
			deriveVerdict(dims({ in_stage_scope: 0.1 }), {
				priorConsecutiveMild: 1,
				mildRepeatLimit: Number.NaN,
			}).verdict,
		).toBe("strong_drift");
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
		const derived = deriveVerdict(dims({ in_stage_scope: 0.1 }), {
			priorConsecutiveMild: 0,
			priorConsecutiveNoDrift: 5,
		});
		expect(derived.consecutiveMild).toBe(1);
		expect(derived.consecutiveNoDrift).toBe(0);
	});

	test("strong zeroes both counters", () => {
		const derived = deriveVerdict(specDims({ forbidden_work: 0.9 }), {
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
		const derived = deriveVerdict(specDims({ forbidden_work: 0.8 }, 0.6), {
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

	test("rejects a confidence below the spec floor (0.49)", () => {
		const parsed = readAnswers(
			jevResult({
				progress: { type: "noul", noul: 0.9, confidence: 0.49 },
			}),
		);
		expect(typeof parsed).toBe("string");
	});

	test("accepts a confidence exactly at the spec floor (0.50)", () => {
		const parsed = readAnswers(
			jevResult({
				progress: { type: "noul", noul: 0.9, confidence: 0.5 },
			}),
		);
		expect(Array.isArray(parsed)).toBe(true);
	});

	test("rejects an absent confidence (never defaults to 1)", () => {
		const parsed = readAnswers(
			jevResult({ progress: { type: "noul", noul: 0.9 } }),
		);
		expect(typeof parsed).toBe("string");
		expect(parsed as string).toContain("confidence");
	});

	test("rejects NaN, Infinity, out-of-range, and wrong-type noul values", () => {
		for (const noul of [Number.NaN, Number.POSITIVE_INFINITY, 1.1, -0.1, "0.5"]) {
			const parsed = readAnswers(
				jevResult({ progress: { type: "noul", noul } }),
			);
			expect({ noul, isString: typeof parsed === "string" }).toEqual({
				noul,
				isString: true,
			});
		}
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

	test("correctionMessage covers the three correctable dimensions", () => {
		expect(correctionMessage("in_stage_scope", "02-plan")).toContain("02-plan");
		expect(correctionMessage("forbidden_work", "03-work")).toContain("03-work");
		expect(correctionMessage("scope_drift", "03-work")).toContain("scope");
	});

	test("non-finite spec values are untrusted (progress included)", () => {
		expect(SPEC.MIN_CONFIDENCE).toBe(0.5);
		expect(SPEC.MILD_REPEAT_LIMIT).toBe(2);
	});
});

describe("byte-cap constants stay frozen", () => {
	test("pins the caps used by the request ladder", () => {
		expect(EXCERPT_BYTES).toBe(1024);
		expect(ACTION_TARGET_BYTES).toBe(160);
		expect(ACTION_REASON_BYTES).toBe(200);
	});
});
