// Docs verification — save-side hook, injection, and tool wiring (plan Unit 8).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types.js";
import { planSlugFromPath } from "../extensions/ce-core/docs-verification/store.js";
import type {
	DocsVerificationRecord,
	FactsInput,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";
import { createContextHandoffTool } from "../extensions/ce-core/tools/context-handoff.js";
import { createDocsVerificationWiring } from "../extensions/ce-core/utils/docs-verification-wiring.js";

const PLAN_PATH = "docs/plans/plan.md";
const PLAN = [
	"### Unit 1 — Alpha",
	"",
	"**Files.**",
	"",
	"- create `src/a.ts`",
	"",
	"Uses `typebox`.",
].join("\n");

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

function factsFor(input: FactsInput): Promise<UnitFacts> {
	return Promise.resolve({
		phase: input.phase,
		declaredFiles: input.declaredFiles.map((p) => ({ path: p, exists: true })),
		packages: [
			{ name: "typebox", version: "1.0.0", versionUnknown: false, kind: "peer" },
		],
		evidence: [],
		versionUnknown: false,
	});
}

function answering(request: JevRequest): JevProcessOutput {
	const answers: Record<string, unknown> = {};
	for (const key of Object.keys(request.questions)) {
		answers[key] = { type: "noul", noul: 0.9, confidence: 0.9 };
	}
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
		stderr: "",
	};
}

function makeWiring(
	mode: "off" | "shadow" | "enforce",
	failClosed: boolean,
	over: Record<string, unknown> = {},
) {
	const records = new Map<string, DocsVerificationRecord>();
	const runtime = createFakeJevRuntime({ handler: answering });
	const wiring = createDocsVerificationWiring({
		mode,
		failClosed,
		runtime,
		deps: {
			facts: factsFor,
			readRecord: async (_repoRoot, slug) => records.get(slug) ?? null,
			writeRecord: (_repoRoot, record) => {
				records.set(planSlugFromPath(record.planPath), record);
				return "memory";
			},
			logRecord: () => undefined,
			now: () => new Date("2026-10-06T00:00:00.000Z"),
		},
		...over,
	});
	return { wiring, records };
}

async function saveWith(wiring: unknown, over: Record<string, unknown> = {}) {
	const tool = createContextHandoffTool({
		gateMode: "off",
		docsVerification: wiring as never,
	});
	return (await tool.execute({
		operation: "save",
		repoRoot: root,
		currentStage: "03-work",
		nextStage: "04-review",
		verification: "bun test: 1 pass, 0 fail",
		...over,
	} as never)) as { blocker?: string; gateWarning?: string; path?: string };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "docs-verification-integration-"));
	await write(PLAN_PATH, PLAN);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("Unit 8 — save-side guarantee", () => {
	test("enforce blocks on an open obligation and writes no handoff artifact", async () => {
		const { wiring } = makeWiring("enforce", false);
		const result = await saveWith(wiring);
		expect(result.blocker).toBeString();
		expect(
			existsSync(path.join(root, ".context/compound-engineering/handoffs/latest.md")),
		).toBe(false);
	});

	test("a save that never calls the tool still runs the evaluation", async () => {
		const { wiring, records } = makeWiring("enforce", false);
		await saveWith(wiring);
		expect(records.size).toBe(1);
	});

	test("a waived obligation lets the save proceed", async () => {
		const { wiring } = makeWiring("enforce", false);
		await saveWith(wiring);
		await wiring.guard.waive({
			repoRoot: root,
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "accepted",
		});
		const result = await saveWith(wiring);
		expect(result.blocker).toBeUndefined();
		expect(
			existsSync(path.join(root, ".context/compound-engineering/handoffs/latest.md")),
		).toBe(true);
	});

	test("off never gates and shadow warns but saves", async () => {
		const off = makeWiring("off", false);
		const offResult = await saveWith(off.wiring);
		expect(offResult.blocker).toBeUndefined();

		const shadow = makeWiring("shadow", false);
		const shadowResult = await saveWith(shadow.wiring);
		expect(shadowResult.blocker).toBeUndefined();
		expect(shadowResult.gateWarning).toContain("open");
	});

	test("a throwing guard fails open with a warning", async () => {
		const boom = {
			run: async () => {
				throw new Error("boom");
			},
		};
		const result = await saveWith(boom);
		expect(result.blocker).toBeUndefined();
		expect(result.gateWarning).toContain("failed open");
	});
});

describe("Unit 8 — injected block", () => {
	test("names the open obligations and the exact contextqmd steps", async () => {
		const { wiring } = makeWiring("shadow", false);
		const block = await wiring.buildAppend({
			repoRoot: root,
			skillPath: "skills/02-plan/SKILL.md",
		});
		expect(block).toBeString();
		expect(block).toContain("alpha");
		expect(block).toContain("contextqmd libraries list");
		expect(block).toContain("contextqmd docs search");
		expect(block).toContain("contextqmd docs get");
		expect(block).toContain("docs-verified:");
	});

	test("injects only for 02-plan and 03-work and never in off", async () => {
		const { wiring } = makeWiring("shadow", false);
		expect(
			await wiring.buildAppend({
				repoRoot: root,
				skillPath: "skills/04-review/SKILL.md",
			}),
		).toBeUndefined();
		const off = makeWiring("off", false);
		expect(
			await off.wiring.buildAppend({
				repoRoot: root,
				skillPath: "skills/02-plan/SKILL.md",
			}),
		).toBeUndefined();
	});

	test("does not inject when there are no open obligations", async () => {
		const { wiring } = makeWiring("shadow", false);
		await wiring.guard.waive({
			repoRoot: root,
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "nothing to do",
		});
		// No record yet, so the waive is a no-op; evaluate to create one, waive, then check.
		await wiring.guard.evaluate({
			repoRoot: root,
			planPath: PLAN_PATH,
			phase: "observed",
			planText: PLAN,
		});
		await wiring.guard.waive({
			repoRoot: root,
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "nothing to do",
		});
		expect(
			await wiring.buildAppend({
				repoRoot: root,
				skillPath: "skills/03-work/SKILL.md",
			}),
		).toBeUndefined();
	});
});
