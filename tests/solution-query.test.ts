import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSolutionsBlock } from "../extensions/ce-core/commands/prompt-inject";
import { collectInjectionQuery } from "../extensions/ce-core/utils/solution-query";
import type {
	RankedSolution,
	SolutionRankingResult,
} from "../extensions/ce-core/utils/solution-ranking";
import { readContextState } from "../extensions/ce-core/tools/workflow-state";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-query-"));
	tempRoots.push(root);
	return root;
}

function writeContextState(repo: string, state: Record<string, unknown>): void {
	const file = path.join(
		repo,
		".context",
		"compound-engineering",
		"context-state.json",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state), "utf8");
}

function ranked(overrides: Partial<RankedSolution> = {}): RankedSolution {
	return {
		path: "docs/solutions/workflow/a.md",
		title: "Alpha",
		category: "workflow",
		severity: "high",
		tags: ["cache"],
		rank: 0.8,
		confidence: 0.9,
		source: "jev",
		content: "Alpha body content.",
		...overrides,
	};
}

function result(
	overrides: Partial<SolutionRankingResult> = {},
): SolutionRankingResult {
	return {
		status: "ok",
		degraded: false,
		enforced: true,
		results: [ranked()],
		conflicts: [],
		...overrides,
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("solution-query — collectInjectionQuery", () => {
	test("assembles currentTruth, then activeFiles, then stage context in order", async () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentTruth: ["Fact A"],
			activeFiles: ["extensions/ce-core/index.ts"],
			openDecisions: ["Decision X"],
		});

		const query = await collectInjectionQuery({
			repoRoot: repo,
			stageKey: "02-plan",
		});

		expect(query).not.toBeNull();
		const text = query as string;
		expect(text.indexOf("Fact A")).toBeLessThan(
			text.indexOf("extensions/ce-core/index.ts"),
		);
		expect(text.indexOf("extensions/ce-core/index.ts")).toBeLessThan(
			text.indexOf("Decision X"),
		);
	});

	test("returns null when context-state is missing", async () => {
		const repo = makeRepo();
		expect(
			await collectInjectionQuery({ repoRoot: repo, stageKey: "02-plan" }),
		).toBeNull();
	});

	test("returns null when context-state has nothing to assemble", async () => {
		const repo = makeRepo();
		writeContextState(repo, { currentTruth: [], activeFiles: [] });

		expect(
			await collectInjectionQuery({ repoRoot: repo, stageKey: "05-learn" }),
		).toBeNull();
	});

	test("bounds the query by UTF-8 bytes", async () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentTruth: ["x".repeat(10_000)],
			activeFiles: [],
		});

		const query = await collectInjectionQuery({
			repoRoot: repo,
			stageKey: "02-plan",
		});

		expect(Buffer.byteLength(query as string, "utf8")).toBeLessThanOrEqual(
			2048 + 32,
		);
	});

	test("uses blocker for 04-5-debug", async () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentTruth: [],
			activeFiles: [],
			blocker: "Build is red",
		});

		const query = await collectInjectionQuery({
			repoRoot: repo,
			stageKey: "04-5-debug",
		});

		expect(query).toContain("Build is red");
	});
});

describe("solution-query — readContextState export", () => {
	test("is exported and returns the documented shape", () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentStage: "02-plan",
			activeFiles: ["a.ts"],
			currentTruth: ["Fact A"],
		});

		const state = readContextState(repo);

		expect(state.found).toBe(true);
		expect(state.currentStage).toBe("02-plan");
		expect(state.activeFiles).toEqual(["a.ts"]);
		expect(state.currentTruth).toEqual(["Fact A"]);
	});

	test("malformed JSON yields an empty context", () => {
		const repo = makeRepo();
		const file = path.join(
			repo,
			".context",
			"compound-engineering",
			"context-state.json",
		);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "{ not valid json", "utf8");

		const state = readContextState(repo);

		expect(state.found).toBe(false);
		expect(state.activeFiles).toEqual([]);
		expect(state.currentTruth).toEqual([]);
	});
});

describe("prompt-inject — formatSolutionsBlock", () => {
	test("returns undefined (not an empty string) when there is nothing to inject", () => {
		expect(
			formatSolutionsBlock(result({ status: "none", results: [] })),
		).toBeUndefined();
		expect(
			formatSolutionsBlock(result({ status: "ok", results: [] })),
		).toBeUndefined();
	});

	test("includes title, path and content for ok results", () => {
		const block = formatSolutionsBlock(result());

		expect(block).toBeDefined();
		expect(block).toContain("Alpha");
		expect(block).toContain("docs/solutions/workflow/a.md");
		expect(block).toContain("Alpha body content.");
	});

	test("annotates degraded results", () => {
		const block = formatSolutionsBlock(
			result({ status: "degraded", degraded: true }),
		);

		expect(block?.toLowerCase()).toContain("degraded");
	});

	test("is pure: identical input yields identical output", () => {
		const input = result();
		expect(formatSolutionsBlock(input)).toBe(formatSolutionsBlock(input));
	});

	test("surfaces overlap conflicts without folding them into content", () => {
		const block = formatSolutionsBlock(
			result({
				conflicts: ["docs/solutions/workflow/a.md"],
			}),
		);

		expect(block).toContain("Potential conflicts");
	});
});
