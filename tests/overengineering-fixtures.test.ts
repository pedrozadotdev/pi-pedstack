// D12 fixture thresholds (plan Unit 8). No live Jev: pure `combineVerdict`.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { combineVerdict } from "../extensions/ce-core/stage-gate/combine.js";
import { OVERENGINEERING_DIMENSION_IDS } from "../extensions/ce-core/overengineering/types.js";
import type { SemanticScoreInput } from "../extensions/ce-core/stage-gate/types.js";

const OVER = new Set<string>(OVERENGINEERING_DIMENSION_IDS);
const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "overengineering");

interface Fixture {
	name: string;
	stage: string;
	baseline: { requirements: boolean; plan: boolean };
	facts: { protectedPaths: string[]; newDependencies: string[] };
	scores: Record<string, number>;
	expected: { overFloorPass: boolean; verdict: "accept" | "review" | "revise" };
}

const fixtures: Fixture[] = readdirSync(FIXTURES_DIR)
	.filter((file) => file.endsWith(".json"))
	.map((file) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), "utf8")) as Fixture);

function toInputs(scores: Record<string, number>): SemanticScoreInput[] {
	return Object.entries(scores).map(([id, score]) => ({
		id,
		score,
		levels: 5,
		confidence: 1,
		weight: 1,
	}));
}

function verdictFor(fixture: Fixture) {
	const sem = toInputs(fixture.scores);
	const result = combineVerdict({
		det: [{ id: "check", critical: true, pass: true, reason: "ok" }],
		sem,
		attempts: 0,
		jevUnavailable: false,
		overengineeringEnforced: true,
	});
	const presentOver = sem.filter((entry) => OVER.has(entry.id));
	const overFloorPass = presentOver.every((entry) => entry.score / entry.levels >= 0.5);
	return { result, presentOver, overFloorPass };
}

describe("overengineering fixtures (Unit 8)", () => {
	test("the fixture set covers the six protected categories", () => {
		const names = fixtures.map((entry) => entry.name);
		expect(names).toContain("protected-validation");
		expect(names).toContain("protected-security");
		expect(names).toContain("protected-observability");
		expect(names).toContain("protected-migration");
		expect(names).toContain("protected-error-handling");
		expect(names).toContain("protected-tests");
	});

	for (const fixture of fixtures) {
		test(`${fixture.name} lands on its threshold verdict`, () => {
			const { result, overFloorPass } = verdictFor(fixture);
			expect(result.verdict).toBe(fixture.expected.verdict);
			expect(overFloorPass).toBe(fixture.expected.overFloorPass);
		});
	}

	test("overengineered-inside-protected is flagged despite a protected path", () => {
		const fixture = fixtures.find(
			(entry) => entry.name === "overengineered-inside-protected",
		) as Fixture;
		expect(fixture.facts.protectedPaths.length).toBeGreaterThan(0);
		const { presentOver, result } = verdictFor(fixture);
		expect(presentOver.length).toBe(4);
		expect(presentOver.every((entry) => entry.score < 2)).toBe(true);
		expect(result.verdict).toBe("review");
	});

	test("base-review-band routes review from the base average, not the over dims", () => {
		const fixture = fixtures.find(
			(entry) => entry.name === "base-review-band",
		) as Fixture;
		const { result } = verdictFor(fixture);
		expect(result.weightedScore as number).toBeGreaterThanOrEqual(0.5);
		expect(result.weightedScore as number).toBeLessThan(0.75);
		expect(result.verdict).toBe("review");
	});

	test("an over dim at exactly 0.5 does not trigger the floor", () => {
		const sem = toInputs({
			evidence_first_findings: 4,
			coverage_across_axes: 4,
			actionable_recommendations: 4,
			no_unrequested_abstraction: 4,
			scope_fidelity: 4,
			complexity_proportionality: 4,
			dependency_justification: 2,
		});
		const result = combineVerdict({
			det: [{ id: "check", critical: true, pass: true, reason: "ok" }],
			sem,
			attempts: 0,
			jevUnavailable: false,
			overengineeringEnforced: true,
		});
		expect(result.verdict).toBe("accept");
	});
});
