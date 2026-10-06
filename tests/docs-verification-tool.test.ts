// Docs verification — `docs_verification` tool operations (plan Unit 7).
import { describe, expect, test } from "bun:test";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types.js";
import { planSlugFromPath } from "../extensions/ce-core/docs-verification/store.js";
import {
	createDocsVerificationTool,
	type DocsVerificationToolDeps,
	type DocsVerificationToolInput,
} from "../extensions/ce-core/tools/docs-verification.js";
import type {
	DocsVerificationRecord,
	FactsInput,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";

const PLAN_PATH = "docs/plans/p.md";
const PLAN = [
	"### Unit 1 — Alpha",
	"",
	"**Files.**",
	"",
	"- create `src/a.ts`",
	"",
	"Uses `typebox`.",
].join("\n");

function factsFor(input: FactsInput): Promise<UnitFacts> {
	return Promise.resolve({
		phase: input.phase,
		declaredFiles: input.declaredFiles.map((path) => ({ path, exists: true })),
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

interface Harness {
	tool: ReturnType<typeof createDocsVerificationTool>;
	records: Map<string, DocsVerificationRecord>;
}

function makeTool(over: Partial<DocsVerificationToolDeps> = {}): Harness {
	const records = new Map<string, DocsVerificationRecord>();
	const runtime = createFakeJevRuntime({ handler: answering });
	const tool = createDocsVerificationTool({
		mode: "shadow",
		failClosed: false,
		runtime,
		facts: factsFor,
		readRecord: async (_repoRoot, slug) => records.get(slug) ?? null,
		writeRecord: (_repoRoot, record) => {
			records.set(planSlugFromPath(record.planPath), record);
			return "memory";
		},
		logRecord: () => undefined,
		now: () => new Date("2026-10-06T00:00:00.000Z"),
		...over,
	});
	return { tool, records };
}

function evaluateInput(
	over: Partial<DocsVerificationToolInput> = {},
): DocsVerificationToolInput {
	return {
		operation: "evaluate",
		repoRoot: "/repo",
		planPath: PLAN_PATH,
		phase: "observed",
		planText: PLAN,
		...over,
	};
}

describe("Unit 7 — docs_verification tool", () => {
	test("evaluate returns the guard result", async () => {
		const { tool } = makeTool();
		const result = await tool.execute(evaluateInput());
		expect(result.operation).toBe("evaluate");
		expect(result.gated).toBe(true);
		expect(result.decision).toBe("required");
		expect(result.reused).toBe(false);
		expect(result.obligations).toHaveLength(1);
	});

	test("evaluate with no resolvable plan is a found:false contract", async () => {
		const { tool } = makeTool();
		const result = await tool.execute(
			evaluateInput({ planPath: undefined, planText: undefined }),
		);
		expect(result.found).toBe(false);
		expect(result.allowed).toBe(true);
	});

	test("status returns the persisted record or found:false", async () => {
		const { tool } = makeTool();
		const missing = await tool.execute({
			operation: "status",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
		});
		expect(missing.found).toBe(false);

		await tool.execute(evaluateInput());
		const found = await tool.execute({
			operation: "status",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
		});
		expect(found.found).toBe(true);
		expect(found.record?.units[0].slug).toBe("alpha");
	});

	test("record accepts a valid docs-verified line and rejects a malformed one", async () => {
		const { tool } = makeTool();
		await tool.execute(evaluateInput());

		const good = await tool.execute({
			operation: "record",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			line: "docs-verified: typebox@1.0.0 docs/typebox.md",
		});
		expect(good.recorded).toBe(true);
		const after = await tool.execute({
			operation: "status",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
		});
		expect(after.record?.units[0].obligation?.status).toBe("satisfied");

		const bad = await tool.execute({
			operation: "record",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			line: "docs-verified: react@18.0.0 docs/react.md",
		});
		expect(bad.recorded).toBe(false);
		expect(typeof bad.reason).toBe("string");
	});

	test("waive requires a non-empty reason and persists a waived obligation", async () => {
		const { tool } = makeTool();
		await tool.execute(evaluateInput());

		const empty = await tool.execute({
			operation: "waive",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "   ",
		});
		expect(empty.waived).toBe(false);
		expect(typeof empty.reason).toBe("string");

		const waived = await tool.execute({
			operation: "waive",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "known false positive",
		});
		expect(waived.waived).toBe(true);
		const after = await tool.execute({
			operation: "status",
			repoRoot: "/repo",
			planPath: PLAN_PATH,
		});
		expect(after.record?.units[0].obligation?.status).toBe("waived");
	});

	test("an unknown operation throws at the dispatch boundary", async () => {
		const { tool } = makeTool();
		await expect(
			tool.execute({
				operation: "frobnicate" as never,
				repoRoot: "/repo",
			}),
		).rejects.toThrow(/unknown operation/i);
	});
});
