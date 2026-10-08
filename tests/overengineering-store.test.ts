// Freshness over baseline paths + tool mode wiring (plan Unit 7).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import { computeArtifactsHash } from "../extensions/ce-core/stage-gate/evidence.js";
import {
	isRecordFresh,
	readLatestRecord,
} from "../extensions/ce-core/stage-gate/store.js";
import type { StageGateAttempt } from "../extensions/ce-core/stage-gate/types.js";
import { createStageGateTool } from "../extensions/ce-core/tools/stage-gate.js";

const FILLER =
	"This paragraph is intentionally long enough to satisfy the minimum length predicate for the artifact under test. It describes context, tradeoffs, and measurable outcomes in enough detail to read as real prose. ";

const PLAN = `# Plan: Stage gate

## Problem summary
${FILLER.repeat(6)}
## Implementation units

### Unit 1 — First unit
- **Files**
  - create \`extensions/ce-core/overengineering/types.ts\`
- **Verification:** \`bun test tests/overengineering-types.test.ts\`

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

function passingRuntime() {
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

function attempt(overrides: Partial<StageGateAttempt> = {}): StageGateAttempt {
	return {
		schema: 2,
		stage: "02-plan",
		verdict: "accept",
		enforcing: true,
		weightedScore: 0.9,
		det: [],
		sem: [],
		criticalFailed: false,
		jevUnavailable: false,
		jevReason: null,
		model: "typesafe/jev",
		warnings: [],
		artifacts: ["docs/plans/x.md"],
		artifactsHash: "hash",
		attempt: 0,
		updatedAt: "2026-10-06T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-store-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering store + tool wiring (Unit 7)", () => {
	test("editing a baseline invalidates a previously fresh accept", async () => {
		await write("docs/plans/x.md", "artifact");
		await write("docs/brainstorms/req.md", "requirements v1");
		const paths = ["docs/plans/x.md", "docs/brainstorms/req.md"];
		const record = attempt({
			artifactsHash: await computeArtifactsHash(root, paths),
			overengineering: {
				facts: {
					newDependencies: [],
					addedFiles: [],
					addedImportsExports: [],
					diffBytes: 0,
					diffExcerptBytes: 0,
					diffExcerpt: "",
					protectedComplexity: [],
					skippedDimensions: [],
					truncated: {
						addedFiles: 0,
						newDependencies: 0,
						addedImportsExports: 0,
						untrackedSkipped: 0,
					},
				},
				baselinePaths: ["docs/brainstorms/req.md"],
				baselineHash: "b",
				skippedDimensions: [],
				source: "jev",
			},
		});
		expect(await isRecordFresh(root, record)).toBe(true);
		await write("docs/brainstorms/req.md", "requirements v2");
		expect(await isRecordFresh(root, record)).toBe(false);
	});

	test("deleting a baseline invalidates", async () => {
		await write("docs/plans/x.md", "artifact");
		await write("docs/brainstorms/req.md", "requirements");
		const record = attempt({
			artifactsHash: await computeArtifactsHash(root, [
				"docs/plans/x.md",
				"docs/brainstorms/req.md",
			]),
			overengineering: {
				facts: {
					newDependencies: [],
					addedFiles: [],
					addedImportsExports: [],
					diffBytes: 0,
					diffExcerptBytes: 0,
					diffExcerpt: "",
					protectedComplexity: [],
					skippedDimensions: [],
					truncated: {
						addedFiles: 0,
						newDependencies: 0,
						addedImportsExports: 0,
						untrackedSkipped: 0,
					},
				},
				baselinePaths: ["docs/brainstorms/req.md"],
				baselineHash: "b",
				skippedDimensions: [],
				source: "jev",
			},
		});
		expect(await isRecordFresh(root, record)).toBe(true);
		await fs.rm(path.join(root, "docs/brainstorms/req.md"));
		expect(await isRecordFresh(root, record)).toBe(false);
	});

	test("an absent overengineering field leaves freshness identical", async () => {
		await write("docs/plans/x.md", "artifact");
		const record = attempt({
			schema: 1,
			artifactsHash: await computeArtifactsHash(root, ["docs/plans/x.md"]),
		});
		expect(await isRecordFresh(root, record)).toBe(true);
		await write("docs/plans/x.md", "changed");
		expect(await isRecordFresh(root, record)).toBe(false);
	});

	test("a malformed overengineering field is tolerated as absent", async () => {
		await write("docs/plans/x.md", "artifact");
		const record = attempt({
			artifactsHash: await computeArtifactsHash(root, ["docs/plans/x.md"]),
		});
		(record as { overengineering: unknown }).overengineering = {
			baselinePaths: "not-an-array",
		};
		expect(await isRecordFresh(root, record)).toBe(true);
	});

	test("the tool defaults to shadow and writes an unavailable record without git", async () => {
		await write("docs/plans/plan.md", PLAN);
		const runtime = passingRuntime();
		const tool = createStageGateTool({ mode: "shadow", runtime });
		const result = await tool.execute({ repoRoot: root, stage: "02-plan" });
		expect(result.error).toBeUndefined();
		expect(runtime.calls.length).toBe(1);
		// No requirements baseline exists, so the composer short-circuits before git.
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.schema).toBe(3);
		expect(record?.overengineering?.source).toBe("unavailable");
	});

	test("the tool forwards an explicit overengineering mode", async () => {
		await write("docs/plans/plan.md", PLAN);
		await write("docs/brainstorms/req.md", "requirements body");
		const runtime = passingRuntime();
		const tool = createStageGateTool({
			mode: "enforce",
			overengineeringMode: "off",
			runtime,
		});
		await tool.execute({ repoRoot: root, stage: "02-plan" });
		const record = await readLatestRecord(root, "02-plan");
		// off mode asks no over dims even though the baseline resolves.
		expect(record?.sem.every((entry) => !entry.id.includes("scope_fidelity"))).toBe(true);
	});
});
