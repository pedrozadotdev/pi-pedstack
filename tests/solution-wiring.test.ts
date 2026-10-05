import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput, JevRequest, JevRuntime } from "../extensions/ce-core/jev/types";
import {
	buildSolutionsAppend,
	composeSolutionSystemPrompt,
	registerSolutionSearch,
} from "../extensions/ce-core/utils/solution-wiring";
import type { SolutionShadowRecord } from "../extensions/ce-core/utils/solution-ranking";
import ceCoreExtension from "../extensions/ce-core/index";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-wiring-"));
	tempRoots.push(root);
	return root;
}

function writeCard(repo: string, relPath: string, title: string): void {
	const full = path.join(repo, relPath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(
		full,
		[
			"---",
			`title: ${title}`,
			"category: workflow",
			"severity: high",
			"tags: [cache, widget]",
			"---",
			"",
			`${title} body content.`,
		].join("\n"),
		"utf8",
	);
}

function writeContextState(repo: string): void {
	const file = path.join(
		repo,
		".context",
		"compound-engineering",
		"context-state.json",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({ currentTruth: ["Fact A"], activeFiles: ["src/a.ts"] }),
		"utf8",
	);
}

function jevOutput(answers: Record<string, unknown>): JevProcessOutput {
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "fake-jev" }),
		stderr: "",
	};
}

function highHandler() {
	return (_request: JevRequest): JevProcessOutput =>
		jevOutput({
			relevance: { type: "noul", noul: 0.9 },
			applicability: { type: "noul", noul: 0.9 },
			reuse: { type: "noul", noul: 0.5 },
		});
}

function createPi() {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, unknown[]>();
	const pi = {
		registerTool(definition: { name: string } & Record<string, unknown>) {
			tools.set(definition.name, definition);
		},
		on(event: string, handler: unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand() {
			// no-op
		},
	};
	return { pi, tools, handlers };
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("registerSolutionSearch", () => {
	test("registers the solution_search tool", () => {
		const { pi, tools } = createPi();

		registerSolutionSearch(pi as never);

		expect(tools.has("solution_search")).toBe(true);
		expect(tools.get("solution_search")?.name).toBe("solution_search");
		expect(tools.get("solution_search")?.parameters).toBeDefined();
	});

	test("executes offline with an injected Jev runtime", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		const { pi, tools } = createPi();
		registerSolutionSearch(pi as never, {
			jev: createFakeJevRuntime({ handler: highHandler() }),
		});

		const definition = tools.get("solution_search") as {
			execute: (
				id: string,
				params: Record<string, unknown>,
			) => Promise<{ content: { text: string }[]; details: { status: string } }>;
		};
		const output = await definition.execute("call-1", {
			query: "cache",
			repoRoot: repo,
		});

		expect(output.details.status).toBe("ok");
		expect(output.content[0].text).toContain("Alpha");
	});
});

describe("buildSolutionsAppend", () => {
	test("does not inject for a non-target stage and never calls Jev", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);
		const jev = createFakeJevRuntime({ handler: highHandler() });

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/01-brainstorm/SKILL.md" },
			{ jev, shadow: false },
		);

		expect(block).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});

	test("returns undefined when there is no query to assemble", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		deleteRepoContext(repo);
		const jev = createFakeJevRuntime({ handler: highHandler() });

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/02-plan/SKILL.md" },
			{ jev, shadow: false },
		);

		expect(block).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});

	test("injects a block when enforced and results qualify", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/02-plan/SKILL.md" },
			{ jev: createFakeJevRuntime({ handler: highHandler() }), shadow: false },
		);

		expect(block).toBeDefined();
		expect(block).toContain("Alpha");
		expect(block).toContain("Alpha body content.");
	});

	test("shadow computes + logs but does not inject", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);
		const records: SolutionShadowRecord[] = [];

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/02-plan/SKILL.md" },
			{
				jev: createFakeJevRuntime({ handler: highHandler() }),
				shadow: true,
				telemetry: (record) => records.push(record),
			},
		);

		expect(block).toBeUndefined();
		expect(records).toHaveLength(1);
		expect(records[0].enforced).toBe(false);
	});

	test("a Jev failure never throws under enforcement and injects a degraded block", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/02-plan/SKILL.md" },
			{
				jev: createFakeJevRuntime({ handler: () => new Error("jev down") }),
				shadow: false,
			},
		);

		expect(block).toBeDefined();
		expect(block?.toLowerCase()).toContain("degraded");
	});

	test("a Jev failure in shadow returns undefined without breaking the turn", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);
		const records: SolutionShadowRecord[] = [];

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/05-learn/SKILL.md" },
			{
				jev: createFakeJevRuntime({ handler: () => new Error("jev down") }),
				telemetry: (record) => records.push(record),
			},
		);

		expect(block).toBeUndefined();
		expect(records[0].status).toBe("degraded");
	});

	test("returns undefined when nothing crosses the threshold", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeContextState(repo);
		const jev = createFakeJevRuntime({
			handler: () =>
				jevOutput({
					relevance: { type: "noul", noul: 0.1 },
					applicability: { type: "noul", noul: 0.1 },
					reuse: { type: "noul", noul: 0.1 },
				}),
		});

		const block = await buildSolutionsAppend(
			{ repoRoot: repo, skillPath: "/skills/04-review/SKILL.md" },
			{ jev, shadow: false },
		);

		expect(block).toBeUndefined();
	});
});

describe("composeSolutionSystemPrompt", () => {
	test("returns undefined when there is nothing to inject (never an empty append)", () => {
		expect(composeSolutionSystemPrompt("base", "", undefined)).toBeUndefined();
	});

	test("appends the base append when present", () => {
		expect(composeSolutionSystemPrompt("base", "APPEND", undefined)).toEqual({
			systemPrompt: "baseAPPEND",
		});
	});

	test("appends the solutions block", () => {
		expect(composeSolutionSystemPrompt("base", "", "SOLUTIONS")).toEqual({
			systemPrompt: "baseSOLUTIONS",
		});
	});
});

describe("index.ts wiring", () => {
	test("registers exactly one before_agent_start handler and the tool", () => {
		const { pi, handlers, tools } = createPi();

		ceCoreExtension(pi as never);

		expect(handlers.get("before_agent_start")?.length).toBe(1);
		expect(tools.has("solution_search")).toBe(true);
	});

	test("wires registerSolutionSearch and the injection helper in the handler", () => {
		const source = readFileSync(
			path.join(import.meta.dir, "..", "extensions", "ce-core", "index.ts"),
			"utf8",
		);

		expect(source).toContain("registerSolutionSearch(pi)");
		expect(source).toContain("buildSolutionsAppend(");
		expect(source).toContain("composeSolutionSystemPrompt(");
	});
});

function deleteRepoContext(repo: string): void {
	rmSync(path.join(repo, ".context"), { recursive: true, force: true });
}
