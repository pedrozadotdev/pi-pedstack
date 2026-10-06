// Overengineering type contract (plan Unit 1): frozen dimension ids, skip
// reasons, structured baselines, and the schema-2 record widening.
import { describe, expect, test } from "bun:test";
import {
	OVERENGINEERING_DIMENSION_IDS,
	OVERENGINEERING_SKIP_REASONS,
	type OverengineeringBaselines,
	type OverengineeringSkipReason,
} from "../extensions/ce-core/overengineering/types.js";
import type { StageGateAttempt } from "../extensions/ce-core/stage-gate/types.js";

/** Compile-time totality guard: every skip reason must appear exactly once. */
const SKIP_REASON_FIXTURES: Record<OverengineeringSkipReason, true> = {
	no_baseline: true,
	baseline_too_weak: true,
	package_json_unreadable: true,
	git_unavailable: true,
	request_too_large: true,
};

function attempt(schema: 1 | 2): StageGateAttempt {
	return {
		schema,
		stage: "02-plan",
		verdict: "accept",
		enforcing: false,
		weightedScore: 1,
		det: [],
		sem: [],
		criticalFailed: false,
		jevUnavailable: false,
		jevReason: null,
		model: "typesafe/jev",
		warnings: [],
		artifacts: [],
		artifactsHash: "hash",
		attempt: 0,
		updatedAt: "2026-10-06T00:00:00.000Z",
	};
}

describe("overengineering types (Unit 1)", () => {
	test("declares exactly the four dimensions in fixed order", () => {
		expect(OVERENGINEERING_DIMENSION_IDS).toEqual([
			"no_unrequested_abstraction",
			"scope_fidelity",
			"complexity_proportionality",
			"dependency_justification",
		]);
	});

	test("the skip reason union is total", () => {
		expect(Object.keys(SKIP_REASON_FIXTURES).sort()).toEqual(
			[...OVERENGINEERING_SKIP_REASONS].sort(),
		);
	});

	test("a schema-1 attempt round-trips without the overengineering field", () => {
		const parsed = JSON.parse(JSON.stringify(attempt(1))) as StageGateAttempt;
		expect(parsed.schema).toBe(1);
		expect("overengineering" in parsed).toBe(false);
	});

	test("a schema-2 attempt round-trips with the overengineering field", () => {
		const record = attempt(2);
		record.overengineering = {
			facts: {
				newDependencies: ["left-pad"],
				addedFiles: ["src/a.ts"],
				addedImportsExports: ["src/a.ts:export foo"],
				diffBytes: 120,
				diffExcerptBytes: 120,
				diffExcerpt: "diff --git a/a.ts b/a.ts",
				protectedComplexity: ["tests"],
				skippedDimensions: [],
				truncated: {
					addedFiles: 0,
					newDependencies: 0,
					addedImportsExports: 0,
					untrackedSkipped: 0,
				},
			},
			baselinePaths: ["docs/brainstorms/req.md"],
			baselineHash: "abc",
			skippedDimensions: [],
			source: "jev",
		};
		const parsed = JSON.parse(JSON.stringify(record)) as StageGateAttempt;
		expect(parsed.schema).toBe(2);
		expect(parsed.overengineering?.source).toBe("jev");
		expect(parsed.overengineering?.facts.newDependencies).toEqual(["left-pad"]);
	});

	test("structured baselines accept requirements-only, plan-only, and dual", () => {
		const requirementsOnly: OverengineeringBaselines = {
			requirements: { text: "req", paths: ["a.md"], truncated: false },
		};
		const planOnly: OverengineeringBaselines = {
			plan: { text: "plan", paths: ["b.md"], truncated: true },
		};
		const dual: OverengineeringBaselines = {
			requirements: { text: "req", paths: ["a.md"], truncated: false },
			plan: { text: "plan", paths: ["b.md"], truncated: false },
		};
		expect(requirementsOnly.plan).toBeUndefined();
		expect(planOnly.requirements).toBeUndefined();
		expect(dual.requirements?.text).toBe("req");
		expect(dual.plan?.truncated).toBe(false);
	});
});
