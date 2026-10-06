// End-to-end wiring (plan Unit 8): a real plan artifact + requirements
// baseline + fake git patch + fake runtime produce a schema-2 record, a shadow
// log line, and a re-derivable reading.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import { OVERENGINEERING_DIMENSION_IDS } from "../extensions/ce-core/overengineering/types.js";
import { evaluateStageGate } from "../extensions/ce-core/stage-gate/evaluate.js";
import { readLatestRecord } from "../extensions/ce-core/stage-gate/store.js";

const OVER = new Set<string>(OVERENGINEERING_DIMENSION_IDS);

const FILLER =
	"This paragraph is intentionally long enough to satisfy the minimum length predicate for the artifact under test. It describes context, tradeoffs, and measurable outcomes in enough detail to read as real prose. ";

const PLAN = `# Plan: Overengineering signal

## Problem summary
${FILLER.repeat(6)}
## Implementation units

### Unit 1 — Types
- **Files**
  - create \`extensions/ce-core/overengineering/types.ts\`
- **Verification:** \`bun test tests/overengineering-types.test.ts\`

## Verification
- RED then GREEN per unit; \`bun test\`; Strict Review applied.
`;

const PATCH = [
	"diff --git a/src/a.ts b/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -0,0 +1 @@",
	"+export const a = 1;",
].join("\n");

const LEVELS: Record<string, string> = {
	"0": "absent",
	"1": "weak",
	"2": "partial",
	"3": "solid",
	"4": "exemplary",
};

function allFourRuntime() {
	return createFakeJevRuntime({
		handler: (request: JevRequest) => {
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(request.questions)) {
				answers[id] = {
					type: "score",
					score: 4,
					legend: LEVELS,
					probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 },
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
		},
	});
}

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-integration-"));
	await write("docs/plans/plan.md", PLAN);
	await write("docs/brainstorms/req.md", "requirements body");
	await write("package.json", "{}");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering integration (Unit 8)", () => {
	test("writes a schema-2 record and a shadow log line", async () => {
		const runtime = allFourRuntime();
		const result = await evaluateStageGate(
			{ runtime, now: () => new Date("2026-10-06T12:00:00.000Z") },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				overengineering: { mode: "enforce", runGit: async () => PATCH },
			},
		);
		expect(result.verdict).toBe("accept");

		const record = await readLatestRecord(root, "02-plan");
		expect(record?.schema).toBe(2);
		expect(record?.overengineering?.source).toBe("jev");
		expect(record?.overengineering?.baselinePaths).toEqual([
			"docs/brainstorms/req.md",
		]);

		const shadow = await fs.readFile(
			path.join(root, ".context/compound-engineering/overengineering-shadow.jsonl"),
			"utf8",
		);
		const lines = shadow.split("\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(1);
		const logged = JSON.parse(lines[0]) as {
			stage: string;
			dimensions: Array<{ id: string; normalized: number }>;
		};
		expect(logged.stage).toBe("02-plan");
		expect(logged.dimensions).toHaveLength(4);
	});

	test("the persisted record re-derives the logged reading", async () => {
		const runtime = allFourRuntime();
		await evaluateStageGate(
			{ runtime, now: () => new Date("2026-10-06T12:00:00.000Z") },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				overengineering: { mode: "enforce", runGit: async () => PATCH },
			},
		);
		const record = await readLatestRecord(root, "02-plan");
		const over = (record?.sem ?? []).filter((entry) => OVER.has(entry.id));
		expect(over).toHaveLength(4);
		const reading = over.reduce((total, entry) => total + entry.normalized, 0) / over.length;
		expect(reading).toBe(1);

		const shadow = await fs.readFile(
			path.join(root, ".context/compound-engineering/overengineering-shadow.jsonl"),
			"utf8",
		);
		const logged = JSON.parse(shadow.trim()) as {
			dimensions: Array<{ normalized: number }>;
		};
		const loggedReading =
			logged.dimensions.reduce((total, entry) => total + entry.normalized, 0) /
			logged.dimensions.length;
		expect(loggedReading).toBe(reading);
	});
});
