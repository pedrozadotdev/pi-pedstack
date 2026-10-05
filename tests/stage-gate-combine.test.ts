// Stage gate verdict combination tests (plan Unit 3: pure combineVerdict).
import { describe, expect, test } from "bun:test";
import {
	combineVerdict,
	DIM_FLOOR,
	MAX_REVISE,
	normalizeScore,
	T_ACCEPT,
	T_REVIEW,
} from "../extensions/ce-core/stage-gate/combine.js";
import type {
	DeterministicResult,
	SemanticScoreInput,
} from "../extensions/ce-core/stage-gate/types.js";

function det(...passes: boolean[]): DeterministicResult[] {
	return passes.map((pass, index) => ({
		id: `check_${index}`,
		critical: true,
		pass,
		reason: pass ? "ok" : "failed",
	}));
}

function sem(
	score: number,
	options: { id?: string; weight?: number; levels?: number } = {},
): SemanticScoreInput {
	return {
		id: options.id ?? "dim",
		score,
		levels: options.levels ?? 5,
		confidence: 0.9,
		weight: options.weight ?? 1,
	};
}

describe("stage gate combine (Unit 3)", () => {
	test("exports the frozen calibration constants", () => {
		expect(T_ACCEPT).toBe(0.75);
		expect(T_REVIEW).toBe(0.5);
		expect(DIM_FLOOR).toBe(0.25);
		expect(MAX_REVISE).toBe(2);
	});

	test("normalizes raw scores against the level count", () => {
		expect(normalizeScore(0, 5)).toBe(0);
		expect(normalizeScore(2, 5)).toBe(0.5);
		expect(normalizeScore(4, 5)).toBe(1);
	});

	test("deterministic floor: a critical failure never yields accept", () => {
		const result = combineVerdict({
			det: det(false),
			sem: [sem(4), sem(4), sem(4), sem(4)],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("revise");
		expect(result.criticalFailed).toBe(true);
	});

	test("deterministic floor escalates once the revise budget is spent", () => {
		const result = combineVerdict({
			det: det(false),
			sem: [sem(4), sem(4), sem(4), sem(4)],
			attempts: MAX_REVISE,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("escalate");
	});

	test("all det pass + weighted >= 0.75 + dims >= 0.25 yields accept", () => {
		const result = combineVerdict({
			det: det(true, true),
			sem: [sem(3), sem(4), sem(3), sem(3)],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("accept");
		expect(result.criticalFailed).toBe(false);
	});

	test("threshold boundaries are exact", () => {
		const base = { det: det(true), attempts: 0, jevUnavailable: false };
		expect(combineVerdict({ ...base, sem: [sem(3)] }).verdict).toBe("accept");
		expect(combineVerdict({ ...base, sem: [sem(2.9996)] }).verdict).toBe("review");
		expect(combineVerdict({ ...base, sem: [sem(2)] }).verdict).toBe("review");
		expect(combineVerdict({ ...base, sem: [sem(1.9996)] }).verdict).toBe("revise");
	});

	test("a dimension below the floor blocks accept even with a high average", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(4), sem(4), sem(4), sem(0.9996)],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.weightedScore as number).toBeGreaterThanOrEqual(T_ACCEPT);
		expect(result.verdict).toBe("review");
	});

	test("a dimension exactly at the floor is allowed", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(4), sem(4), sem(4), sem(1)],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("accept");
	});

	test("weighted average uses sum(w*s)/sum(w) with unequal weights", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(4, { weight: 3 }), sem(1, { weight: 1 })],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.weightedScore).toBeCloseTo(0.8125, 10);
	});

	test("Jev outage falls back to deterministic-only, never review", () => {
		const allPass = combineVerdict({
			det: det(true, true),
			sem: [],
			attempts: 0,
			jevUnavailable: true,
		});
		expect(allPass.verdict).toBe("accept");
		expect(allPass.weightedScore).toBeNull();

		const anyFail = combineVerdict({
			det: det(true, false),
			sem: [],
			attempts: 0,
			jevUnavailable: true,
		});
		expect(anyFail.verdict).toBe("revise");
	});

	test("a third revise escalates", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(1)],
			attempts: MAX_REVISE,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("escalate");
	});

	test("a review verdict is not escalated by the revise budget", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(2.5)],
			attempts: MAX_REVISE,
			jevUnavailable: false,
		});
		expect(result.verdict).toBe("review");
	});

	test("returns normalized semantic scores for the record", () => {
		const result = combineVerdict({
			det: det(true),
			sem: [sem(3)],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(result.sem[0].normalized).toBe(0.75);
		expect(result.sem[0].weight).toBe(1);
	});
});
