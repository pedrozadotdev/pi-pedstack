// Overengineering engine wiring (plan Unit 6): conditional request injection,
// floor-only semantics, schema-2 persistence, and the size trim ladder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types.js";
import { composeOverengineeringSignal } from "../extensions/ce-core/overengineering/compose.js";
import { OVERENGINEERING_DIMENSION_IDS } from "../extensions/ce-core/overengineering/types.js";
import {
	buildStageGateRequest,
	MAX_REQUEST_BYTES,
} from "../extensions/ce-core/stage-gate/evaluate.js";
import { evaluateStageGate } from "../extensions/ce-core/stage-gate/evaluate.js";
import { getStageRubric } from "../extensions/ce-core/stage-gate/rubrics.js";
import { readLatestRecord } from "../extensions/ce-core/stage-gate/store.js";
import type { Evidence } from "../extensions/ce-core/stage-gate/types.js";

const OVER = new Set<string>(OVERENGINEERING_DIMENSION_IDS);

const LEVELS: Record<string, string> = {
	"0": "absent",
	"1": "weak",
	"2": "partial",
	"3": "solid",
	"4": "exemplary",
};

const PATCH = [
	"diff --git a/src/a.ts b/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -0,0 +1 @@",
	"+export const a = 1;",
].join("\n");

function probabilitiesFor(score: number): Record<string, number> {
	const probabilities: Record<string, number> = {
		"0": 0,
		"1": 0,
		"2": 0,
		"3": 0,
		"4": 0,
	};
	probabilities[String(score)] = 1;
	return probabilities;
}

function scoring(overScore: number) {
	return (request: JevRequest): JevProcessOutput => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			const score = OVER.has(id) ? overScore : 4;
			answers[id] = {
				type: "score",
				score,
				legend: LEVELS,
				probabilities: probabilitiesFor(score),
				confidence: 0.9,
			};
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({
				model: "typesafe/jev",
				answers,
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			stderr: "",
		};
	};
}

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

async function writeReviewRepo(withRequirements: boolean): Promise<void> {
	if (withRequirements) await write("docs/brainstorms/req.md", "requirements body");
	await write("docs/plans/plan.md", "plan body");
	await write("package.json", "{}");
	await write(
		".context/compound-engineering/review-findings/x-04-review.json",
		JSON.stringify({
			findings: [{ severity: "high", evidence: "src/a.ts:1 problem" }],
			count: 1,
		}),
	);
}

function evidenceWith(txt: string): Evidence {
	return {
		stage: "04-review",
		repoRoot: root,
		artifacts: [],
		files: [],
		txt,
		errors: [],
		warnings: [],
		reviewFindings: [],
		checkpoints: [],
		contextState: null,
		planText: null,
		gitDiff: null,
		truncated: false,
		obligations: null,
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-engine-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering engine (Unit 6)", () => {
	test("signal-ready enforcement scores the four dims and persists schema 2", async () => {
		await writeReviewRepo(true);
		const runtime = createFakeJevRuntime({ handler: scoring(4) });
		const result = await evaluateStageGate(
			{ runtime, now: () => new Date("2026-10-06T00:00:00.000Z") },
			{
				repoRoot: root,
				stage: "04-review",
				mode: "enforce",
				overengineering: { mode: "enforce", runGit: async () => PATCH },
			},
		);
		const overIds = result.sem.filter((entry) => OVER.has(entry.id));
		expect(overIds).toHaveLength(4);
		expect(result.verdict).toBe("accept");
		const record = await readLatestRecord(root, "04-review");
		expect(record?.schema).toBe(2);
		expect(record?.overengineering?.source).toBe("jev");
		expect(record?.overengineering?.baselinePaths).toEqual([
			"docs/brainstorms/req.md",
			"docs/plans/plan.md",
		]);
		expect(record?.overengineering?.baselineHash.length).toBeGreaterThan(0);
		expect(record?.overengineering?.facts).toBeDefined();
	});

	test("the four dims are absent from sem when the signal is unavailable", async () => {
		await write("docs/plans/plan.md", "# Plan\n\nTODO");
		const runtime = createFakeJevRuntime({ handler: scoring(4) });
		const result = await evaluateStageGate(
			{ runtime },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);
		expect(result.sem.every((entry) => !OVER.has(entry.id))).toBe(true);
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.overengineering?.source).toBe("unavailable");
	});

	test("a skipped dim is absent and cannot trigger the floor", async () => {
		await writeReviewRepo(false);
		const runtime = createFakeJevRuntime({ handler: scoring(4) });
		const result = await evaluateStageGate(
			{ runtime },
			{
				repoRoot: root,
				stage: "04-review",
				mode: "enforce",
				overengineering: { mode: "enforce", runGit: async () => PATCH },
			},
		);
		expect(result.sem.some((entry) => entry.id === "scope_fidelity")).toBe(false);
		expect(result.verdict).toBe("accept");
		const record = await readLatestRecord(root, "04-review");
		expect(record?.overengineering?.skippedDimensions).toEqual([
			{ dimension: "scope_fidelity", reason: "no_baseline" },
		]);
	});

	test("off mode never calls git and asks only the base dims", async () => {
		await writeReviewRepo(true);
		let gitCalls = 0;
		const runtime = createFakeJevRuntime({ handler: scoring(1) });
		const result = await evaluateStageGate(
			{ runtime },
			{
				repoRoot: root,
				stage: "04-review",
				mode: "enforce",
				overengineering: {
					mode: "off",
					runGit: async () => {
						gitCalls++;
						return PATCH;
					},
				},
			},
		);
		expect(gitCalls).toBe(0);
		expect(result.sem.every((entry) => !OVER.has(entry.id))).toBe(true);
	});

	test("shadow persists the four dims but keeps weightedScore/verdict identical to off", async () => {
		await writeReviewRepo(true);
		const off = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring(4) }) },
			{
				repoRoot: root,
				stage: "04-review",
				mode: "shadow",
				overengineering: { mode: "off", runGit: async () => PATCH },
			},
		);
		const shadow = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring(1) }) },
			{
				repoRoot: root,
				stage: "04-review",
				mode: "shadow",
				overengineering: { mode: "shadow", runGit: async () => PATCH },
			},
		);
		expect(shadow.sem.filter((entry) => OVER.has(entry.id))).toHaveLength(4);
		expect(off.sem.filter((entry) => OVER.has(entry.id))).toHaveLength(0);
		expect(shadow.weightedScore).toBe(off.weightedScore);
		expect(shadow.verdict).toBe(off.verdict);
	});

	test("the request state injects both baselines for 04-review", async () => {
		await writeReviewRepo(true);
		const signal = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "04-review",
			mode: "shadow",
			runGit: async () => PATCH,
		});
		const built = buildStageGateRequest(
			evidenceWith("review text"),
			getStageRubric("04-review"),
			[],
			signal,
		);
		const state = built.request.state as {
			baselines: { requirements?: { text: string }; plan?: { text: string } };
		};
		expect(state.baselines.requirements?.text).toBe("requirements body");
		expect(state.baselines.plan?.text).toBe("plan body");
	});

	test("a 48 KiB artifact plus the full signal stays under the 64 KiB cap", async () => {
		await writeReviewRepo(true);
		const signal = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "04-review",
			mode: "enforce",
			runGit: async () => PATCH,
		});
		const built = buildStageGateRequest(
			evidenceWith("x".repeat(48 * 1024)),
			getStageRubric("04-review"),
			[],
			signal,
		);
		expect(Buffer.byteLength(JSON.stringify(built.request), "utf8")).toBeLessThanOrEqual(
			MAX_REQUEST_BYTES,
		);
		expect(Object.keys(built.request.questions).length).toBeLessThanOrEqual(32);
		expect(built.requestTooLarge).toBe(false);
	});

	test("an oversized escaping artifact exhausts the ladder to the composer-off request", async () => {
		await writeReviewRepo(true);
		const signal = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "04-review",
			mode: "enforce",
			runGit: async () => PATCH,
		});
		const off = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "04-review",
			mode: "off",
		});
		const evidence = evidenceWith("\\".repeat(48 * 1024));
		const built = buildStageGateRequest(
			evidence,
			getStageRubric("04-review"),
			[],
			signal,
		);
		const offBuilt = buildStageGateRequest(
			evidence,
			getStageRubric("04-review"),
			[],
			off,
		);
		expect(built.requestTooLarge).toBe(true);
		expect(JSON.stringify(built.request)).toBe(JSON.stringify(offBuilt.request));
	});
});
