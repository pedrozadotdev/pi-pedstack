// Handoff readiness — context_handoff save/validate integration (plan Unit 6).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest, JevRuntime } from "../extensions/ce-core/jev/types.js";
import { THRESHOLDS_VERSION } from "../extensions/ce-core/handoff-readiness/combine.js";
import {
	READINESS_LOG_FILE,
	pairSlug,
	readinessRecordPath,
	writeReadinessRecord,
} from "../extensions/ce-core/handoff-readiness/store.js";
import type { ReadinessRecord } from "../extensions/ce-core/handoff-readiness/types.js";
import { createContextHandoffTool } from "../extensions/ce-core/tools/context-handoff.js";
import type { ContextHandoffReadinessOptions } from "../extensions/ce-core/tools/context-handoff.js";

const GOOD: Record<string, number> = {
	continuation_sufficiency: 1,
	next_step_clarity: 1,
	verification_support: 1,
	blocking_open_decisions: 0,
	history_need: 0,
};

const GOOD_MARKDOWN = [
	"## Current Task",
	"Continue from 02-plan to 03-work.",
	"",
	"## Next Minimal Step",
	"- Implement Unit 6 in extensions/ce-core/tools/context-handoff.ts",
	"",
	"## Verification",
	"- bun test tests/handoff-readiness-integration.test.ts: 20 pass",
	"",
].join("\n");

let root: string;

function answering(
	values: Record<string, number> = GOOD,
): (request: JevRequest) => {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			answers[id] = { type: "noul", noul: values[id] ?? 1, confidence: 0.9 };
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
			stderr: "",
		};
	};
}

const throwingRuntime: JevRuntime = {
	async decide() {
		throw new Error("validate must not call decide");
	},
};

function makeTool(
	readiness: ContextHandoffReadinessOptions,
	gateMode: "off" | "shadow" | "enforce" = "off",
) {
	return createContextHandoffTool({ gateMode, readiness });
}

function save(
	tool: ReturnType<typeof createContextHandoffTool>,
	input: Record<string, unknown> = {},
) {
	return tool.execute({
		operation: "save",
		repoRoot: root,
		currentStage: "02-plan",
		nextStage: "03-work",
		contextHealth: "good",
		...input,
	} as never) as Promise<{
		blocker?: string;
		readiness?: ReadinessRecord & { verdict: string };
		gateWarning?: string;
	}>;
}

async function exists(rel: string): Promise<boolean> {
	const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
	try {
		await fs.stat(abs);
		return true;
	} catch {
		return false;
	}
}

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
}

function storedRecord(over: Partial<ReadinessRecord> = {}): ReadinessRecord {
	return {
		schema: 1,
		pair: pairSlug("02-plan", "03-work"),
		hash: "abcdef0123456789",
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: "improve_handoff",
		source: "jev",
		dimensions: [],
		corrections: [
			{ dimension: "next_step_clarity", message: "name a concrete step" },
		],
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

async function seedState(stage = "02-plan", next = "03-work"): Promise<void> {
	await write(
		".context/compound-engineering/context-state.json",
		JSON.stringify(
			{
				currentStage: stage,
				nextStage: next,
				contextHealth: "good",
				activeFiles: [],
				artifacts: {},
				currentTruth: [],
				invalidatedAssumptions: [],
				openDecisions: [],
				recentlyAccessedFiles: [],
				compressionRisk: [],
				activeRules: [],
				recommendNewSession: false,
				updatedAt: "2026-10-06T00:00:00.000Z",
			},
			null,
			2,
		),
	);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-readiness-int-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("Unit 6 — save wiring", () => {
	test("shadow warns on a semantically useless handoff and still writes it", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "shadow", failClosed: false, runtime: jev });
		const result = await save(tool, { verification: "N/A" });
		expect(result.blocker).toBeUndefined();
		expect(result.readiness?.verdict).toBe("improve_handoff");
		expect(result.gateWarning).toContain("handoff readiness");
		expect(
			await exists(".context/compound-engineering/handoffs/latest.md"),
		).toBe(true);
		expect(
			await exists(readinessRecordPath(root, pairSlug("02-plan", "03-work"))),
		).toBe(true);
		expect(await exists(READINESS_LOG_FILE)).toBe(true);
	});

	test("enforce blocks with the corrections and zero handoff side effects", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "enforce", failClosed: false, runtime: jev });
		const result = await save(tool, { verification: "N/A" });
		expect(result.blocker).toContain("Next Minimal Step");
		expect(
			await exists(".context/compound-engineering/handoffs/latest.md"),
		).toBe(false);
		expect(
			await exists(".context/compound-engineering/context-state.json"),
		).toBe(false);
		expect(
			await exists(readinessRecordPath(root, pairSlug("02-plan", "03-work"))),
		).toBe(true);
	});

	test("enforce allows a good handoff when the fake runtime says continue", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "enforce", failClosed: false, runtime: jev });
		const result = await save(tool, {
			verification: "bun test: 20 pass",
			handoffMarkdown: GOOD_MARKDOWN,
		});
		expect(result.blocker).toBeUndefined();
		expect(result.readiness?.verdict).toBe("continue");
		expect(
			await exists(".context/compound-engineering/handoffs/latest.md"),
		).toBe(true);
	});

	test("two identical saves call the fake runtime once", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "shadow", failClosed: false, runtime: jev });
		const input = {
			verification: "bun test: 20 pass",
			handoffMarkdown: GOOD_MARKDOWN,
		};
		await save(tool, input);
		await save(tool, input);
		expect(jev.requests).toHaveLength(1);
	});

	test("off mode changes nothing", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "off", failClosed: false, runtime: jev });
		const result = await save(tool, { verification: "N/A" });
		expect(result.readiness).toBeUndefined();
		expect(
			await exists(readinessRecordPath(root, pairSlug("02-plan", "03-work"))),
		).toBe(false);
		expect(jev.requests).toEqual([]);
		expect(
			await exists(".context/compound-engineering/handoffs/latest.md"),
		).toBe(true);
	});
});

describe("Unit 6 — deterministic floor wins", () => {
	test("a non-empty checklist blocks before readiness and never calls Jev", async () => {
		await write(
			".context/checklist.json",
			JSON.stringify({ items: [{ description: "pending", addedAt: "x" }] }),
		);
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool({ mode: "enforce", failClosed: false, runtime: jev });
		const result = await save(tool, {
			verification: "bun test: 20 pass",
			handoffMarkdown: GOOD_MARKDOWN,
		});
		expect(result.blocker).toContain("checklist");
		expect(result.readiness).toBeUndefined();
		expect(jev.requests).toEqual([]);
	});

	test("a stage-gate critical failure blocks before readiness and never calls Jev", async () => {
		const jev = createFakeJevRuntime({ handler: answering() });
		const tool = makeTool(
			{ mode: "enforce", failClosed: false, runtime: jev },
			"enforce",
		);
		let fileProbes = 0;
		const withSpy = createContextHandoffTool({
			gateMode: "enforce",
			readiness: {
				mode: "enforce",
				failClosed: false,
				runtime: jev,
				fileExists: () => {
					fileProbes += 1;
					return true;
				},
			},
		});
		const result = await save(withSpy, {
			verification: "bun test: 20 pass",
			handoffMarkdown: GOOD_MARKDOWN,
		});
		expect(result.blocker).toContain("deterministic");
		expect(result.readiness).toBeUndefined();
		expect(jev.requests).toEqual([]);
		expect(fileProbes).toBe(0);
		expect(tool).toBeDefined();
	});
});

describe("Unit 6 — validate surfacing", () => {
	test("surfaces a record for the input pair without calling decide", async () => {
		await writeReadinessRecord(root, storedRecord());
		const tool = makeTool({
			mode: "shadow",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await tool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: "02-plan",
			nextStage: "03-work",
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness?.verdict).toBe("improve_handoff");
		expect(result.readiness?.corrections[0].message).toBe(
			"name a concrete step",
		);
	});

	test("falls back to the state pair", async () => {
		await seedState();
		await writeReadinessRecord(root, storedRecord());
		const tool = makeTool({
			mode: "shadow",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await tool.execute({
			operation: "validate",
			repoRoot: root,
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness?.verdict).toBe("improve_handoff");
	});

	test("falls back to the handoff-path pair", async () => {
		await writeReadinessRecord(root, storedRecord());
		const tool = makeTool({
			mode: "shadow",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await tool.execute({
			operation: "validate",
			repoRoot: root,
			handoffPath:
				".context/compound-engineering/handoffs/2026-10-06T02-20-03-320Z-02-plan-to-03-work.md",
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness?.verdict).toBe("improve_handoff");
	});

	test("returns no readiness when no record exists", async () => {
		const tool = makeTool({
			mode: "shadow",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await tool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: "02-plan",
			nextStage: "03-work",
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness).toBeUndefined();
	});

	test("surfaces the record written by a blocked save even with no handoff", async () => {
		const jev = createFakeJevRuntime({
			handler: answering({ ...GOOD, next_step_clarity: 0 }),
		});
		const saveTool = makeTool({
			mode: "enforce",
			failClosed: false,
			runtime: jev,
		});
		const saved = await save(saveTool, {
			verification: "bun test: 20 pass",
			handoffMarkdown: GOOD_MARKDOWN,
		});
		expect(saved.blocker).toBeString();
		expect(
			await exists(".context/compound-engineering/handoffs/latest.md"),
		).toBe(false);

		const validateTool = makeTool({
			mode: "shadow",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await validateTool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: "02-plan",
			nextStage: "03-work",
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness?.verdict).toBe("improve_handoff");
	});

	test("off mode surfaces no readiness", async () => {
		await writeReadinessRecord(root, storedRecord());
		const tool = makeTool({
			mode: "off",
			failClosed: false,
			runtime: throwingRuntime,
		});
		const result = (await tool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: "02-plan",
			nextStage: "03-work",
		} as never)) as { readiness?: ReadinessRecord };
		expect(result.readiness).toBeUndefined();
	});
});
