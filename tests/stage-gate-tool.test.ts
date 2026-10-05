// stage_gate tool tests (plan Unit 6: tool surface + registration wiring).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types.js";
import {
	createStageGateTool,
	stageGateParams,
} from "../extensions/ce-core/tools/stage-gate.js";
import { readLatestRecord } from "../extensions/ce-core/stage-gate/store.js";

const FILLER =
	"This paragraph is intentionally long enough to satisfy the minimum length predicate for the artifact under test. It describes context, tradeoffs, and measurable outcomes in enough detail to read as real prose. ";

const PLAN = `# Plan: Stage gate

## Problem summary
${FILLER.repeat(6)}
## Implementation units

### Unit 1 — First unit
- **Files**
  - create \`extensions/ce-core/stage-gate/types.ts\`
- **Verification:** \`bun test tests/stage-gate-rubrics.test.ts\`

## Verification
- RED then GREEN per unit; \`bun test\`; Strict Review applied.
`;

const LEVELS: Record<string, string> = {
	"0": "absent",
	"1": "weak",
	"2": "partial",
	"3": "solid",
	"4": "exemplary",
};

function scoring(scores: number[]) {
	let index = 0;
	return (request: JevRequest): JevProcessOutput => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			const score = scores[index % scores.length] ?? 4;
			index++;
			const probabilities: Record<string, number> = {
				"0": 0,
				"1": 0,
				"2": 0,
				"3": 0,
				"4": 0,
			};
			probabilities[String(score)] = 1;
			answers[id] = {
				type: "score",
				score,
				legend: LEVELS,
				probabilities,
				confidence: 0.9,
			};
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({ model: "typesafe/jev", answers }),
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

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-tool-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("stage_gate tool (Unit 6)", () => {
	test("returns accept for a good artifact with an injected fake runtime", async () => {
		await write("docs/plans/plan.md", PLAN);
		const tool = createStageGateTool({
			mode: "enforce",
			runtime: createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) }),
		});

		const result = await tool.execute({ repoRoot: root, stage: "02-plan" });

		expect(result.verdict).toBe("accept");
		expect(result.enforcing).toBe(true);
	});

	test("returns an explicit error result for an unknown stage without throwing", async () => {
		const tool = createStageGateTool({ mode: "enforce" });
		const result = await tool.execute({ repoRoot: root, stage: "99-nope" });
		expect(result.error).toContain("99-nope");
		expect(result.verdict).toBeUndefined();
	});

	test("off mode writes no record and never calls Jev", async () => {
		await write("docs/plans/plan.md", PLAN);
		const runtime = createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) });
		const tool = createStageGateTool({ mode: "off", runtime });

		const result = await tool.execute({ repoRoot: root, stage: "02-plan" });

		expect(result.skipped).toBe(true);
		expect(runtime.calls.length).toBe(0);
		expect(await readLatestRecord(root, "02-plan")).toBeNull();
	});

	test("artifactPaths are path-only per the parameter schema", () => {
		const valid = {
			repoRoot: root,
			stage: "02-plan",
			artifactPaths: ["docs/plans/plan.md"],
		};
		expect(Value.Check(stageGateParams, valid)).toBe(true);
		expect(
			Value.Check(stageGateParams, {
				repoRoot: root,
				stage: "02-plan",
				artifactPaths: [{ text: "favorable prose" }],
			}),
		).toBe(false);
	});
});
