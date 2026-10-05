import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types";
import { createSolutionSearchTool } from "../extensions/ce-core/tools/solution-search";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-search-"));
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
			`${title} body about cache invalidation.`,
		].join("\n"),
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

const HIGH_ANSWERS = {
	relevance: { type: "noul", noul: 0.9 },
	applicability: { type: "noul", noul: 0.9 },
	reuse: { type: "noul", noul: 0.6 },
};

function highHandler() {
	return (_request: JevRequest): JevProcessOutput => jevOutput(HIGH_ANSWERS);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("solution_search tool", () => {
	test("exposes model-facing metadata", () => {
		const tool = createSolutionSearchTool();

		expect(tool.name).toBe("solution_search");
		expect(tool.description.toLowerCase()).toContain("solution");
	});

	test("ok: formats every field and includes the card content", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha Cache");
		const tool = createSolutionSearchTool({
			jev: createFakeJevRuntime({ handler: highHandler() }),
		});

		const { text, result } = await tool.execute({ query: "cache", repoRoot: repo });

		expect(result.status).toBe("ok");
		expect(text).toContain("docs/solutions/workflow/a.md");
		expect(text).toContain("Alpha Cache");
		expect(text).toContain("workflow");
		expect(text).toContain("high");
		expect(text).toContain("cache, widget");
		expect(text).toContain("rank");
		expect(text).toContain("confidence");
		expect(text).toContain("jev");
		expect(text).toContain("Alpha Cache body about cache invalidation.");
	});

	test("none: returns an explicit no-relevant-solutions message", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		const tool = createSolutionSearchTool({
			jev: createFakeJevRuntime({
				handler: () =>
					jevOutput({
						relevance: { type: "noul", noul: 0.1 },
						applicability: { type: "noul", noul: 0.1 },
						reuse: { type: "noul", noul: 0.1 },
					}),
			}),
		});

		const { text, result } = await tool.execute({ query: "cache", repoRoot: repo });

		expect(result.status).toBe("none");
		expect(text).toContain("No relevant solutions found.");
	});

	test("degraded: returns a degraded notice plus prior-ranked results", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		const tool = createSolutionSearchTool({
			jev: createFakeJevRuntime({ handler: () => new Error("jev down") }),
		});

		const { text, result } = await tool.execute({ query: "cache", repoRoot: repo });

		expect(result.status).toBe("degraded");
		expect(result.results).toHaveLength(1);
		expect(text.toLowerCase()).toContain("degraded");
		expect(text).toContain("docs/solutions/workflow/a.md");
	});

	test("honours a per-call limit override", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		writeCard(repo, "docs/solutions/workflow/b.md", "Beta");
		writeCard(repo, "docs/solutions/workflow/c.md", "Gamma");
		const tool = createSolutionSearchTool({
			jev: createFakeJevRuntime({ handler: highHandler() }),
		});

		const { result } = await tool.execute({
			query: "cache",
			repoRoot: repo,
			limit: 1,
		});

		expect(result.results).toHaveLength(1);
	});

	test("creates the runtime lazily and reuses it across executes", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		let factoryCalls = 0;
		const tool = createSolutionSearchTool({
			jevFactory: () => {
				factoryCalls++;
				return createFakeJevRuntime({ handler: highHandler() });
			},
		});

		expect(factoryCalls).toBe(0);
		await tool.execute({ query: "cache", repoRoot: repo });
		expect(factoryCalls).toBe(1);
		await tool.execute({ query: "cache", repoRoot: repo });
		expect(factoryCalls).toBe(1);
	});

	test("passes the overlap mode through to the engine", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", "Alpha");
		const fake = createFakeJevRuntime({
			handler: (request) =>
				jevOutput(
					Object.fromEntries(
						Object.keys(request.questions).map((id) => [
							id,
							{ type: "noul", noul: 0.9 },
						]),
					),
				),
		});
		const tool = createSolutionSearchTool({ jev: fake });

		await tool.execute({ query: "cache", repoRoot: repo, mode: "overlap" });

		expect(Object.keys(fake.requests[0].questions).sort()).toEqual([
			"conflict",
			"duplicate",
			"overlap",
		]);
	});
});
