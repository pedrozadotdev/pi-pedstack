// Stage gate engine tests (plan Unit 5: deterministic first, Jev second).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors.js";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types.js";
import { evaluateStageGate } from "../extensions/ce-core/stage-gate/evaluate.js";
import { appendRecord, readLatestRecord } from "../extensions/ce-core/stage-gate/store.js";
import type {
	ReviewPolicyDecision,
	StageGateAttempt,
	StageGateVerdict,
} from "../extensions/ce-core/stage-gate/types.js";

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

### Unit 2 — Second unit
- **Files**
  - create \`extensions/ce-core/stage-gate/rubrics.ts\`
- **Verification:** \`bun test tests/stage-gate-combine.test.ts\`

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

function probabilitiesFor(score: number): Record<string, number> {
	const probabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
	probabilities[String(score)] = 1;
	return probabilities;
}

function scoring(scores: number[]) {
	let index = 0;
	return (request: JevRequest): JevProcessOutput => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			const score = scores[index % scores.length] ?? 4;
			index++;
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
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
			stderr: "",
		};
	};
}

function priorRevise(): StageGateAttempt {
	return priorAttempt("revise");
}

function priorAttempt(
	verdict: StageGateVerdict,
	review?: ReviewPolicyDecision,
): StageGateAttempt {
	return {
		schema: 1,
		stage: "02-plan",
		verdict,
		enforcing: true,
		weightedScore: null,
		det: [],
		sem: [],
		criticalFailed: false,
		jevUnavailable: false,
		jevReason: null,
		model: "typesafe/jev",
		warnings: [],
		artifacts: [],
		artifactsHash: "x",
		attempt: 0,
		updatedAt: "2026-10-05T00:00:00.000Z",
		review,
	};
}

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-engine-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("stage gate engine (Unit 5)", () => {
	test("happy accept persists an enforcing record", async () => {
		await write("docs/plans/plan.md", PLAN);
		const runtime = createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) });

		const result = await evaluateStageGate(
			{ runtime, now: () => new Date("2026-10-05T00:00:00.000Z") },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);

		expect(result.verdict).toBe("accept");
		expect(result.enforcing).toBe(true);
		expect(result.weightedScore).toBe(1);
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.verdict).toBe("accept");
		expect(record?.enforcing).toBe(true);
		expect(record?.artifacts).toEqual(["docs/plans/plan.md"]);
	});

	test("hollow artifact short-circuits before any Jev call", async () => {
		await write("docs/plans/hollow.md", "# Hollow\n\nTODO");
		const runtime = createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) });

		const result = await evaluateStageGate(
			{ runtime },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);

		expect(result.verdict).toBe("revise");
		expect(result.sem).toEqual([]);
		expect(runtime.calls.length).toBe(0);
	});

	test("Jev runtime errors degrade to deterministic-only, never throwing", async () => {
		await write("docs/plans/plan.md", PLAN);
		for (const code of ["timeout", "invalid_response", "missing_executable"] as const) {
			const runtime = createFakeJevRuntime({
				queue: [new JevRuntimeError({ code, message: `boom-${code}` })],
			});
			const result = await evaluateStageGate(
				{ runtime },
				{ repoRoot: root, stage: "02-plan", mode: "enforce" },
			);
			expect(result.verdict).toBe("accept");
			expect(result.jevUnavailable).toBe(true);
			expect(result.sem).toEqual([]);
			expect(result.jevReason).toContain(`boom-${code}`);
		}
	});

	test("review and revise bands produce the expected verdicts", async () => {
		await write("docs/plans/plan.md", PLAN);
		const review = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([2, 2, 2, 2]) }) },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);
		expect(review.verdict).toBe("review");

		const revise = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([1, 1, 1, 1]) }) },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);
		expect(revise.verdict).toBe("revise");
	});

	test("a third revise escalates and records the attempt counter", async () => {
		await write("docs/plans/hollow.md", "# Hollow\n\nTODO");
		await appendRecord(root, priorRevise());
		await appendRecord(root, priorRevise());

		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) }) },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);

		expect(result.verdict).toBe("escalate");
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.attempt).toBe(2);
	});

	test("bounds the request even with a 64 KiB artifact", async () => {
		await write("docs/plans/plan.md", `${PLAN}\n${"x".repeat(64 * 1024)}`);
		const runtime = createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) });

		const result = await evaluateStageGate(
			{ runtime },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);

		expect(result.verdict).toBe("accept");
		expect(runtime.calls.length).toBe(1);
		const stdin = runtime.calls[0].stdin as string;
		expect(Buffer.byteLength(stdin, "utf8")).toBeLessThanOrEqual(65_536);
		const parsed = JSON.parse(stdin) as JevRequest;
		expect(Object.keys(parsed.questions).length).toBeLessThanOrEqual(32);
	});

	test("shadow mode marks the record as non-enforcing", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) }) },
			{ repoRoot: root, stage: "02-plan", mode: "shadow" },
		);
		expect(result.enforcing).toBe(false);
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.enforcing).toBe(false);
	});

	test("rejects an escaping artifactPaths hint and never scores it", async () => {
		const escape = path.join(root, "..", "escape.md");
		await fs.writeFile(escape, "# Escape\n\nTODO");
		const runtime = createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) });

		const result = await evaluateStageGate(
			{ runtime },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				artifactPaths: ["../escape.md"],
			},
		);

		expect(result.artifacts).toEqual([]);
		expect(runtime.calls.length).toBe(0);
		await fs.rm(escape, { force: true });
	});
});

describe("stage gate engine — review action (Unit 5)", () => {
	test("a review verdict with an available reviewer returns and persists action review", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([2, 2, 2, 2]) }) },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				reviewerAvailable: true,
			},
		);

		expect(result.verdict).toBe("review");
		expect(result.action).toBe("review");
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.review?.action).toBe("review");
		expect(record?.review?.reviewerCount).toBe(1);
	});

	test("a second review verdict in the same loop escalates", async () => {
		await write("docs/plans/plan.md", PLAN);
		await appendRecord(root, priorAttempt("review"));

		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([2, 2, 2, 2]) }) },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				reviewerAvailable: true,
			},
		);

		expect(result.action).toBe("escalate");
		const record = await readLatestRecord(root, "02-plan");
		expect(record?.review?.action).toBe("escalate");
	});

	test("a review verdict after an intervening accept starts a new loop", async () => {
		await write("docs/plans/plan.md", PLAN);
		await appendRecord(root, priorAttempt("review"));
		await appendRecord(root, priorAttempt("accept"));

		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([2, 2, 2, 2]) }) },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				reviewerAvailable: true,
			},
		);

		expect(result.action).toBe("review");
	});

	test("review with reviewerAvailable false escalates", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([2, 2, 2, 2]) }) },
			{
				repoRoot: root,
				stage: "02-plan",
				mode: "enforce",
				reviewerAvailable: false,
			},
		);

		expect(result.action).toBe("escalate");
		expect(result.actionReason.length).toBeGreaterThan(0);
	});

	test("an accept verdict returns action none", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await evaluateStageGate(
			{ runtime: createFakeJevRuntime({ handler: scoring([4, 4, 4, 4]) }) },
			{ repoRoot: root, stage: "02-plan", mode: "enforce" },
		);

		expect(result.verdict).toBe("accept");
		expect(result.action).toBe("none");
	});
});
