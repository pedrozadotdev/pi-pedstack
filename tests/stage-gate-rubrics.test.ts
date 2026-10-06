// Stage gate rubric tests (plan Unit 1: pure deterministic evaluator).
import { describe, expect, test } from "bun:test";
import { combineVerdict } from "../extensions/ce-core/stage-gate/combine.js";
import {
	evaluateDeterministic,
	getStageRubric,
	stageRubrics,
} from "../extensions/ce-core/stage-gate/rubrics.js";
import type {
	CheckpointRecord,
	DeterministicResult,
	Evidence,
	EvidenceFile,
	EvidenceObligations,
	ReviewFindingsFile,
	StageKey,
} from "../extensions/ce-core/stage-gate/types.js";

const FILLER =
	"This paragraph is intentionally long enough to satisfy the minimum length predicate for the artifact under test. It describes context, tradeoffs, and measurable outcomes in enough detail to read as real prose. ";

function file(path: string, text: string): EvidenceFile {
	return { path, text, bytes: Buffer.byteLength(text, "utf8") };
}

function finding(severity?: string, evidence?: string): {
	severity?: string;
	evidence?: string;
} {
	return { severity, evidence };
}

function evidence(
	stage: StageKey,
	overrides: Partial<Evidence> = {},
): Evidence {
	const txt = overrides.txt ?? "";
	return {
		stage,
		repoRoot: "/repo",
		artifacts: overrides.artifacts ?? [],
		files: overrides.files ?? (txt ? [file("artifact.md", txt)] : []),
		txt,
		errors: [],
		warnings: [],
		reviewFindings: [],
		checkpoints: [],
		contextState: null,
		planText: null,
		gitDiff: null,
		truncated: false,
		obligations: overrides.obligations ?? null,
		priorGate: overrides.priorGate ?? null,
		...overrides,
	};
}

function run(stage: StageKey, overrides: Partial<Evidence> = {}): DeterministicResult[] {
	return evaluateDeterministic(getStageRubric(stage), evidence(stage, overrides));
}

function resultFor(results: DeterministicResult[], id: string): DeterministicResult {
	const found = results.find((entry) => entry.id === id);
	if (!found) throw new Error(`missing deterministic result "${id}"`);
	return found;
}

function expectPass(results: DeterministicResult[], id: string): void {
	const found = resultFor(results, id);
	expect({ id, pass: found.pass, reason: found.reason }).toEqual({
		id,
		pass: true,
		reason: found.reason,
	});
}

function expectFail(results: DeterministicResult[], id: string): void {
	const found = resultFor(results, id);
	expect({ id, pass: found.pass }).toEqual({ id, pass: false });
	expect(found.reason.length).toBeGreaterThan(0);
}

const BRAINSTORM_COMPLETE = `# Brainstorm: Stage gate

## Problem
${FILLER.repeat(4)}
## Goals
- Stop hollow artifacts from clearing a stage.
## Non-goals
- Model routing.
## Approach
- Option A and Option B compared.
## Recommended
Option B.
## Success
- A hollow artifact is rejected by the gate.
`;

const PLAN_COMPLETE = `# Plan: Stage gate

## Problem summary
${FILLER}${FILLER}
## Implementation units

### Unit 1 — First unit
- **Files**
  - create \`extensions/ce-core/stage-gate/types.ts\`
- **Verification:** \`bun test tests/stage-gate-rubrics.test.ts\`

### Unit 2 — Second unit
- **Files**
  - create \`extensions/ce-core/stage-gate/rubrics.ts\`
- **Verification:** \`bun test tests/stage-gate-combine.test.ts\`

## Verification
- RED then GREEN per unit; \`bun test\`; Strict Review applied.
`;

describe("stage gate rubrics (Unit 1)", () => {
	test("defines exactly the 7 stage rubrics with unique check ids", () => {
		const stages: StageKey[] = [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
			"06-docsync",
		];
		expect(Object.keys(stageRubrics).sort()).toEqual([...stages].sort());
		for (const stage of stages) {
			const rubric = getStageRubric(stage);
			const ids = rubric.checks.map((check) => check.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(rubric.checks.length).toBeGreaterThan(0);
			expect(rubric.semanticDimensions.length).toBeGreaterThan(0);
		}
	});

	test("01-brainstorm: hollow fixture fails length, headings, and placeholders", () => {
		const results = run("01-brainstorm", {
			txt: "# Hollow\n\nTODO: fill this in",
		});
		expectFail(results, "min_length");
		expectFail(results, "required_headings");
		expectFail(results, "no_placeholders");
	});

	test("01-brainstorm: complete fixture passes every deterministic check", () => {
		const results = run("01-brainstorm", {
			txt: BRAINSTORM_COMPLETE,
			reviewFindings: [
				{
					path: ".context/compound-engineering/review-findings/x-01-brainstorm.json",
					count: 1,
					findings: [finding("high", "docs/plans/x.md:10")],
				},
			],
		});
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("01-brainstorm: no prior gate and no sidecar passes multi_reviewer_findings", () => {
		const results = run("01-brainstorm", { txt: BRAINSTORM_COMPLETE });
		expectPass(results, "multi_reviewer_findings");
	});

	test("01-brainstorm: prior action review and no sidecar fails", () => {
		const results = run("01-brainstorm", {
			txt: BRAINSTORM_COMPLETE,
			priorGate: { verdict: "review", action: "review" },
		});
		expectFail(results, "multi_reviewer_findings");
	});

	test("01-brainstorm: prior action review and a zero-finding sidecar passes", () => {
		const results = run("01-brainstorm", {
			txt: BRAINSTORM_COMPLETE,
			priorGate: { verdict: "review", action: "review" },
			reviewFindings: [
				{ path: "review-findings/x-01-brainstorm.json", count: 0, findings: [] },
			],
		});
		expectPass(results, "multi_reviewer_findings");
	});

	test("01-brainstorm: a sidecar whose count mismatches fails", () => {
		const results = run("01-brainstorm", {
			txt: BRAINSTORM_COMPLETE,
			reviewFindings: [
				{ path: "review-findings/x-01-brainstorm.json", count: 3, findings: [] },
			],
		});
		expectFail(results, "multi_reviewer_findings");
	});

	test("02-plan: hollow fixture fails length", () => {
		const results = run("02-plan", { txt: "# Plan\n\nTODO" });
		expectFail(results, "min_length");
	});

	test("02-plan: complete fixture passes every deterministic check", () => {
		const results = run("02-plan", { txt: PLAN_COMPLETE });
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("02-plan: units lacking a Files line fail units_name_files", () => {
		const txt = PLAN_COMPLETE.replace(
			"- **Files**\n  - create `extensions/ce-core/stage-gate/types.ts`\n",
			"- **Goal:** no files named here\n",
		);
		expectFail(run("02-plan", { txt }), "units_name_files");
	});

	test("02-plan: missing RED/GREEN fails tdd_gates_stated", () => {
		const txt = PLAN_COMPLETE.replace(/RED then GREEN per unit;/, "tests described;");
		expectFail(run("02-plan", { txt }), "tdd_gates_stated");
	});

	test("02-plan: missing Strict Review fails strict_review_recorded", () => {
		const txt = PLAN_COMPLETE.replace(/ Strict Review applied\./, " Review applied.");
		expectFail(run("02-plan", { txt }), "strict_review_recorded");
	});

	test("03-work: no verification fails work_verification_recorded", () => {
		const results = run("03-work", {
			txt: "Work report with no result marker.",
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			planText: PLAN_COMPLETE,
		});
		expectFail(results, "work_verification_recorded");
	});

	test("03-work: '1 fail' fails tests_not_failing", () => {
		const results = run("03-work", {
			txt: "bun test: 10 pass, 1 fail",
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			planText: PLAN_COMPLETE,
		});
		expectPass(results, "work_verification_recorded");
		expectFail(results, "tests_not_failing");
	});

	test("03-work: '0 fail' passes tests_not_failing", () => {
		const results = run("03-work", {
			txt: "bun test: 10 pass, 0 fail",
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			planText: PLAN_COMPLETE,
		});
		expectPass(results, "work_verification_recorded");
		expectPass(results, "tests_not_failing");
	});

	test("03-work: missing checkpoint fails checkpoint_consistent", () => {
		const results = run("03-work", {
			txt: "bun test: 10 pass, 0 fail",
			planText: PLAN_COMPLETE,
		});
		expectFail(results, "checkpoint_consistent");
	});

	test("03-work: complete fixture passes every deterministic check", () => {
		const results = run("03-work", {
			txt: "bun test: 548 pass, 0 fail",
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			planText: PLAN_COMPLETE,
		});
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("04-review: no prior gate and no sidecar passes review_findings_persisted", () => {
		expectPass(run("04-review", {}), "review_findings_persisted");
	});

	test("04-review: prior action review and no sidecar fails", () => {
		const results = run("04-review", {
			priorGate: { verdict: "review", action: "review" },
		});
		expectFail(results, "review_findings_persisted");
	});

	test("04-review: prior action review with a well-formed sidecar passes", () => {
		const files: ReviewFindingsFile[] = [
			{
				path: "review-findings/x-04-review.json",
				count: 1,
				findings: [finding("high", "src/app.ts:12")],
			},
		];
		const results = run("04-review", {
			priorGate: { verdict: "review", action: "review" },
			reviewFindings: files,
		});
		expectPass(results, "review_findings_persisted");
	});

	test("04-review: prior action accept and no sidecar passes", () => {
		const results = run("04-review", {
			priorGate: { verdict: "accept", action: "none" },
		});
		expectPass(results, "review_findings_persisted");
	});

	test("the two findings predicates remain critical", () => {
		const brainstorm = resultFor(
			run("01-brainstorm", { txt: BRAINSTORM_COMPLETE }),
			"multi_reviewer_findings",
		);
		const review = resultFor(run("04-review", {}), "review_findings_persisted");
		expect(brainstorm.critical).toBe(true);
		expect(review.critical).toBe(true);
	});

	test("04-review: unknown severity fails severity_classified", () => {
		const files: ReviewFindingsFile[] = [
			{
				path: "review-findings/x-04-review.json",
				count: 1,
				findings: [finding("critical", "src/app.ts:12")],
			},
		];
		const results = run("04-review", { reviewFindings: files });
		expectPass(results, "review_findings_persisted");
		expectFail(results, "severity_classified");
	});

	test("04-review: evidence without path:line fails findings_reference_file_line", () => {
		const files: ReviewFindingsFile[] = [
			{
				path: "review-findings/x-04-review.json",
				count: 1,
				findings: [finding("high", "somewhere in the code")],
			},
		];
		expectFail(run("04-review", { reviewFindings: files }), "findings_reference_file_line");
	});

	test("04-review: complete fixture passes every deterministic check", () => {
		const files: ReviewFindingsFile[] = [
			{
				path: "review-findings/x-04-review.json",
				count: 2,
				findings: [
					finding("high", "src/app.ts:12"),
					finding("low", "src/util.ts:4"),
				],
			},
		];
		const results = run("04-review", { reviewFindings: files });
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("04-5-debug: missing Root cause fails root_cause_stated", () => {
		const results = run("04-5-debug", {
			txt: "bun test: 10 pass, 0 fail\nSee tests/x.test.ts",
		});
		expectFail(results, "root_cause_stated");
	});

	test("04-5-debug: missing regression reference fails regression_test_referenced", () => {
		const results = run("04-5-debug", {
			txt: "## Root cause\nThe null check was inverted.\nbun test: 10 pass, 0 fail",
		});
		expectFail(results, "regression_test_referenced");
	});

	test("04-5-debug: complete fixture passes every deterministic check", () => {
		const results = run("04-5-debug", {
			txt: "## Root cause\nThe null check was inverted.\nbun test: 10 pass, 0 fail\nSee tests/x.test.ts",
		});
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("05-learn: missing ## Solution fails required_headings", () => {
		const results = run("05-learn", {
			txt: `# Learn\n\n## Problem\n${FILLER.repeat(3)}\n## Overlap\nNone.\n`,
		});
		expectFail(results, "required_headings");
	});

	test("05-learn: missing overlap check fails overlap_check_referenced", () => {
		const results = run("05-learn", {
			txt: `# Learn\n\n## Problem\n${FILLER.repeat(3)}\n## Solution\nDone.\n`,
		});
		expectFail(results, "overlap_check_referenced");
	});

	test("05-learn: complete fixture passes every deterministic check", () => {
		const results = run("05-learn", {
			txt: `# Learn\n\n## Problem\n${FILLER.repeat(3)}\n## Solution\nOverlap checked; nothing existed.\n`,
		});
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("06-docsync: missing README/AGENTS outcome fails docsync_evaluated", () => {
		const results = run("06-docsync", {
			txt: "exit criteria: met",
		});
		expectFail(results, "docsync_evaluated");
	});

	test("06-docsync: missing exit criteria fails exit_criteria_met", () => {
		const results = run("06-docsync", {
			txt: "README updated to match code.",
		});
		expectFail(results, "exit_criteria_met");
	});

	test("06-docsync: complete fixture passes every deterministic check", () => {
		const results = run("06-docsync", {
			txt: "README updated to match code. Exit criteria: met.",
		});
		for (const result of results) {
			expect({ id: result.id, pass: result.pass }).toEqual({ id: result.id, pass: true });
		}
	});

	test("missing artifact set fails the critical artifact_present for doc stages", () => {
		for (const stage of ["01-brainstorm", "02-plan", "05-learn"] as StageKey[]) {
			const results = run(stage, { files: [], txt: "" });
			const presence = resultFor(results, "artifact_present");
			expect({ stage, critical: presence.critical, pass: presence.pass }).toEqual({
				stage,
				critical: true,
				pass: false,
			});
		}
	});

	test("no_placeholders rejects placeholder tokens and accepts larger words", () => {
		const rubric = getStageRubric("01-brainstorm");
		for (const token of ["TODO", "TBD", "FIXME", "XXX", "lorem ipsum", "<fill this>"]) {
			const results = evaluateDeterministic(rubric, evidence("01-brainstorm", { txt: token }));
			expect({ token, pass: resultFor(results, "no_placeholders").pass }).toEqual({
				token,
				pass: false,
			});
		}
		const ok = evaluateDeterministic(
			rubric,
			evidence("01-brainstorm", { txt: "Todoist and todos are larger words." }),
		);
		expectPass(ok, "no_placeholders");
	});

	test("checkpoint status failed fails checkpoint_consistent", () => {
		const checkpoints: CheckpointRecord[] = [
			{ path: "checkpoints/c.json", status: "failed", completedUnits: ["u1"] },
		];
		const results = run("03-work", {
			txt: "bun test: 10 pass, 0 fail",
			checkpoints,
			planText: PLAN_COMPLETE,
		});
		expectFail(results, "checkpoint_consistent");
	});

	test("evidence with no plan skips the completedUnits requirement", () => {
		const results = run("03-work", {
			txt: "bun test: 10 pass, 0 fail",
			checkpoints: [{ path: "checkpoints/c.json", status: "ok" }],
		});
		expectPass(results, "checkpoint_consistent");
	});
});

function obligations(over: Partial<EvidenceObligations> = {}): EvidenceObligations {
	return {
		applicable: true,
		planHasExternalPackages: true,
		storePresent: true,
		stale: false,
		degraded: false,
		failClosed: false,
		open: 0,
		satisfied: 1,
		waived: 0,
		...over,
	};
}

describe("stage gate rubrics — source_verification_obligations (Unit 6)", () => {
	test("is a non-critical check on the 02-plan and 03-work rubrics", () => {
		for (const stage of ["02-plan", "03-work"] as StageKey[]) {
			const found = resultFor(
				run(stage, { txt: PLAN_COMPLETE }),
				"source_verification_obligations",
			);
			expect({ stage, critical: found.critical }).toEqual({ stage, critical: false });
		}
	});

	test("null obligations pass", () => {
		expectPass(run("02-plan", { txt: PLAN_COMPLETE }), "source_verification_obligations");
	});

	test("no detectable external packages pass", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ planHasExternalPackages: false, storePresent: false }),
		});
		expectPass(results, "source_verification_obligations");
	});

	test("all obligations satisfied or waived pass", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ satisfied: 2, waived: 1, open: 0 }),
		});
		expectPass(results, "source_verification_obligations");
	});

	test("an open obligation fails", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ open: 1, satisfied: 0 }),
		});
		expectFail(results, "source_verification_obligations");
	});

	test("a stale store fails", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ stale: true }),
		});
		expectFail(results, "source_verification_obligations");
	});

	test("a missing store with external packages fails", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ storePresent: false, satisfied: 0 }),
		});
		expectFail(results, "source_verification_obligations");
	});

	test("degraded passes when fail-closed is 0 and fails when it is 1", () => {
		const lenient = run("03-work", {
			txt: "bun test: 1 pass, 0 fail",
			planText: PLAN_COMPLETE,
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			obligations: obligations({ degraded: true, open: 1, satisfied: 0, failClosed: false }),
		});
		expectPass(lenient, "source_verification_obligations");

		const strict = run("03-work", {
			txt: "bun test: 1 pass, 0 fail",
			planText: PLAN_COMPLETE,
			checkpoints: [{ path: "checkpoints/c.json", status: "ok", completedUnits: ["u1"] }],
			obligations: obligations({ degraded: true, open: 1, satisfied: 0, failClosed: true }),
		});
		expectFail(strict, "source_verification_obligations");
	});

	test("an off / out-of-scope record passes even with external packages", () => {
		const results = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({
				applicable: false,
				storePresent: false,
				satisfied: 0,
				planHasExternalPackages: true,
			}),
		});
		expectPass(results, "source_verification_obligations");
	});

	test("a non-critical failure yields revise and never accept", () => {
		const det = run("02-plan", {
			txt: PLAN_COMPLETE,
			obligations: obligations({ open: 1, satisfied: 0 }),
		});
		const combined = combineVerdict({
			det,
			sem: [
				{ id: "unit_atomicity", score: 4, levels: 5, confidence: 1, weight: 1 },
			],
			attempts: 0,
			jevUnavailable: false,
		});
		expect(combined.verdict).toBe("revise");
		expect(combined.criticalFailed).toBe(false);
	});
});
