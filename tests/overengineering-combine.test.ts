// Dedicated overengineering floor + floor-only partition (plan Unit 2).
import { describe, expect, test } from "bun:test";
import {
	combineVerdict,
	DIM_FLOOR,
	OVERENGINEERING_FLOOR,
	T_ACCEPT,
	T_REVIEW,
} from "../extensions/ce-core/stage-gate/combine.js";
import { OVERENGINEERING_DIMENSION_IDS } from "../extensions/ce-core/overengineering/types.js";
import type {
	DeterministicResult,
	SemanticScoreInput,
} from "../extensions/ce-core/stage-gate/types.js";

const OVER_IDS = OVERENGINEERING_DIMENSION_IDS;

function det(pass = true): DeterministicResult[] {
	return [{ id: "check", critical: true, pass, reason: pass ? "ok" : "failed" }];
}

function sem(
	score: number,
	id = "base",
	weight = 1,
): SemanticScoreInput {
	return { id, score, levels: 5, confidence: 0.9, weight };
}

function baseDims(score: number, count = 4): SemanticScoreInput[] {
	return Array.from({ length: count }, (_, index) =>
		sem(score, `base_${index}`),
	);
}

function overDims(scores: number[]): SemanticScoreInput[] {
	return scores.map((score, index) => sem(score, OVER_IDS[index]));
}

describe("overengineering combine floor (Unit 2)", () => {
	test("exports the frozen overengineering floor", () => {
		expect(OVERENGINEERING_FLOOR).toBe(0.5);
	});

	test("enforced floor with a present over dim at 1 blocks accept", () => {
		const result = combineVerdict({
			det: det(),
			sem: [...baseDims(4, 3), ...overDims([1])],
			attempts: 0,
			jevUnavailable: false,
			overengineeringEnforced: true,
		});
		expect(result.weightedScore).toBe(1);
		expect(result.verdict).toBe("review");
	});

	test("enforced: false with the same input keeps accept", () => {
		const result = combineVerdict({
			det: det(),
			sem: [...baseDims(4, 3), ...overDims([1])],
			attempts: 0,
			jevUnavailable: false,
			overengineeringEnforced: false,
		});
		expect(result.verdict).toBe("accept");
	});

	test("quorum: 1, 2, and 3 present over dims each trigger the floor", () => {
		for (const count of [1, 2, 3]) {
			const scores = Array.from({ length: count }, (_, index) =>
				index === count - 1 ? 1 : 4,
			);
			const result = combineVerdict({
				det: det(),
				sem: [...baseDims(4, 4), ...overDims(scores)],
				attempts: 0,
				jevUnavailable: false,
				overengineeringEnforced: true,
			});
			expect(result.verdict).toBe("review");
		}
	});

	test("the four dims do not shift weightedScore", () => {
		const without = combineVerdict({
			det: det(),
			sem: baseDims(4, 3),
			attempts: 0,
			jevUnavailable: false,
		});
		const withOver = combineVerdict({
			det: det(),
			sem: [...baseDims(4, 3), ...overDims([1, 1, 1, 1])],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(withOver.weightedScore).toBe(without.weightedScore);
		expect(withOver.weightedScore).toBe(1);
	});

	test("an over dim at exactly 0.5 does not trigger the floor", () => {
		const result = combineVerdict({
			det: det(),
			sem: [...baseDims(4, 4), ...overDims([2])],
			attempts: 0,
			jevUnavailable: false,
			overengineeringEnforced: true,
		});
		expect(result.verdict).toBe("accept");
	});

	test("the floor cannot be masked by high base dims nor mask them", () => {
		const lowBase = combineVerdict({
			det: det(),
			sem: [...baseDims(4, 3), sem(0.9996, "base_low"), ...overDims([4])],
			attempts: 0,
			jevUnavailable: false,
			overengineeringEnforced: true,
		});
		expect(lowBase.verdict).toBe("review");
	});

	test("a full outage is unchanged: accept, null score, empty sem", () => {
		const result = combineVerdict({
			det: det(),
			sem: [],
			attempts: 0,
			jevUnavailable: true,
			overengineeringEnforced: true,
		});
		expect(result.verdict).toBe("accept");
		expect(result.weightedScore).toBeNull();
		expect(result.sem).toEqual([]);
	});

	test("DIM_FLOOR/T_ACCEPT/T_REVIEW are unchanged", () => {
		expect(DIM_FLOOR).toBe(0.25);
		expect(T_ACCEPT).toBe(0.75);
		expect(T_REVIEW).toBe(0.5);
	});
});
