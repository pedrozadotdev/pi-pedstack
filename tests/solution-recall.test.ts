import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	parseSolutionFrontmatter,
	extractKeywords,
	computePrior,
	recallSolutionCandidates,
	type ParsedFrontmatter,
} from "../extensions/ce-core/utils/solution-recall";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-recall-"));
	tempRoots.push(root);
	return root;
}

function card(
	title: string,
	category: string,
	severity: string,
	tags: string[],
): string {
	return [
		"---",
		`title: ${title}`,
		`category: ${category}`,
		`severity: ${severity}`,
		`tags: [${tags.join(", ")}]`,
		"---",
		"",
		"Body text.",
	].join("\n");
}

function writeCard(repo: string, relPath: string, content: string): void {
	const full = path.join(repo, relPath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

function frontmatter(overrides: Partial<ParsedFrontmatter>): ParsedFrontmatter {
	return {
		title: "",
		category: "",
		severity: null,
		tags: [],
		applies_when: [],
		malformed: false,
		...overrides,
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("solution-recall — parseSolutionFrontmatter", () => {
	test("parses title/category/severity with inline tags and block applies_when", () => {
		const content = [
			"---",
			"title: Widget Cache Invalidation",
			"category: architecture",
			"severity: high",
			"tags: [cache, widget, invalidation]",
			"applies_when:",
			"  - Cache entries are stale",
			"  - Widgets render old data",
			"---",
			"",
			"## Body",
			"Some explanation that must not leak.",
		].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.title).toBe("Widget Cache Invalidation");
		expect(result.category).toBe("architecture");
		expect(result.severity).toBe("high");
		expect(result.tags).toEqual(["cache", "widget", "invalidation"]);
		expect(result.applies_when).toEqual([
			"Cache entries are stale",
			"Widgets render old data",
		]);
		expect(result.malformed).toBe(false);
	});

	test("parses block tags and inline applies_when", () => {
		const content = [
			"---",
			"title: Block Lists",
			"category: workflow",
			"severity: low",
			"tags:",
			"  - alpha",
			"  - beta",
			"applies_when: [first, second]",
			"---",
		].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.tags).toEqual(["alpha", "beta"]);
		expect(result.applies_when).toEqual(["first", "second"]);
	});

	test("treats keys case-insensitively and strips surrounding quotes", () => {
		const content = [
			"---",
			"TITLE: 'Quoted Title'",
			"Category: \"quoted category\"",
			"SEVERITY: 'critical'",
			"Tags: ['one', \"two\"]",
			"---",
		].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.title).toBe("Quoted Title");
		expect(result.category).toBe("quoted category");
		expect(result.severity).toBe("critical");
		expect(result.tags).toEqual(["one", "two"]);
	});

	test("ignores extra keys", () => {
		const content = [
			"---",
			"title: Has Extras",
			"category: tooling",
			"severity: medium",
			"author: nobody",
			"version: 3",
			"tags: [x, y]",
			"---",
		].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.title).toBe("Has Extras");
		expect(result.tags).toEqual(["x", "y"]);
	});

	test("defaults missing fields to empty and missing severity to null", () => {
		const content = ["---", "title: Only Title", "---"].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.title).toBe("Only Title");
		expect(result.category).toBe("");
		expect(result.severity).toBeNull();
		expect(result.tags).toEqual([]);
		expect(result.applies_when).toEqual([]);
		expect(result.malformed).toBe(false);
	});

	test("content with no frontmatter is malformed with empty fields (never throws)", () => {
		const result = parseSolutionFrontmatter("# Just a heading\n\nBody text.");

		expect(result.malformed).toBe(true);
		expect(result.title).toBe("");
		expect(result.category).toBe("");
		expect(result.severity).toBeNull();
		expect(result.tags).toEqual([]);
		expect(result.applies_when).toEqual([]);
	});

	test("unterminated frontmatter is malformed with empty fields", () => {
		const result = parseSolutionFrontmatter("---\ntitle: Never Closed\n");

		expect(result.malformed).toBe(true);
		expect(result.title).toBe("");
	});

	test("empty string and whitespace-only input are malformed", () => {
		expect(parseSolutionFrontmatter("").malformed).toBe(true);
		expect(parseSolutionFrontmatter("   \n\t\n").malformed).toBe(true);
	});

	test("does not leak body text into fields", () => {
		const content = [
			"---",
			"title: Scoped",
			"category: testing",
			"severity: high",
			"tags: [scope]",
			"---",
			"",
			"severity: critical",
			"title: injected",
			"tags: [leak]",
		].join("\n");

		const result = parseSolutionFrontmatter(content);

		expect(result.title).toBe("Scoped");
		expect(result.severity).toBe("high");
		expect(result.tags).toEqual(["scope"]);
	});
});

describe("solution-recall — computePrior", () => {
	test("applies each severity weight when there is no tag or category overlap", () => {
		expect(computePrior(frontmatter({ severity: "critical" }), [])).toBeCloseTo(0.6, 10);
		expect(computePrior(frontmatter({ severity: "high" }), [])).toBeCloseTo(0.45, 10);
		expect(computePrior(frontmatter({ severity: "medium" }), [])).toBeCloseTo(0.3, 10);
		expect(computePrior(frontmatter({ severity: "low" }), [])).toBeCloseTo(0.15, 10);
		expect(computePrior(frontmatter({ severity: null }), [])).toBeCloseTo(0, 10);
		expect(computePrior(frontmatter({ severity: "LOW" }), [])).toBeCloseTo(0.15, 10);
	});

	test("computes the tag-overlap ratio with the max(1, min(...)) denominator", () => {
		// intersection 1, min(|q|=2, |tags|=2) = 2 -> 0.5
		expect(
			computePrior(frontmatter({ tags: ["cache", "legacy"] }), ["cache", "widget"]),
		).toBeCloseTo(0.3 * 0.5, 10);
		// intersection 1, min(2, 1) = 1 -> 1.0
		expect(computePrior(frontmatter({ tags: ["cache"] }), ["cache", "widget"])).toBeCloseTo(
			0.3,
			10,
		);
		// empty tags never divide by zero
		expect(computePrior(frontmatter({ tags: [] }), ["cache"])).toBeCloseTo(0, 10);
	});

	test("adds the category match bonus", () => {
		expect(
			computePrior(frontmatter({ category: "workflow" }), ["workflow"]),
		).toBeCloseTo(0.1, 10);
		expect(
			computePrior(frontmatter({ category: "workflow" }), ["tooling"]),
		).toBeCloseTo(0, 10);
	});

	test("combines all three terms and clamps to 1", () => {
		expect(
			computePrior(
				frontmatter({ severity: "critical", category: "workflow", tags: ["cache"] }),
				["cache", "workflow"],
			),
		).toBeCloseTo(1, 10);
	});

	test("body fallback contributes overlap only when frontmatter hits < 3", () => {
		const sparse = frontmatter({ severity: "medium", tags: [] });
		// 0 frontmatter hits -> body tokens are used
		expect(computePrior(sparse, ["cache", "widget"], "cache widget")).toBeCloseTo(
			0.3 + 0.3,
			10,
		);

		const hits = frontmatter({ severity: "medium", tags: ["alpha", "beta", "gamma"] });
		const query = ["alpha", "beta", "gamma", "delta"];
		// 3 frontmatter hits -> body text is ignored, even when it would match
		expect(
			computePrior(hits, query, "delta delta delta"),
		).toBeCloseTo(computePrior(hits, query), 10);
	});

	test("malformed frontmatter always scores 0", () => {
		expect(
			computePrior(frontmatter({ malformed: true, severity: "critical", tags: ["cache"] }), ["cache"]),
		).toBe(0);
	});
});

describe("solution-recall — recallSolutionCandidates", () => {
	test("discovers cards recursively across category subdirectories", () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "workflow", "high", ["cache"]));
		writeCard(repo, "docs/solutions/tooling/b.md", card("B", "tooling", "low", ["cache"]));

		const results = recallSolutionCandidates({ repoRoot: repo, query: "cache" });

		expect(results.map((r) => r.relPath)).toEqual([
			"docs/solutions/workflow/a.md",
			"docs/solutions/tooling/b.md",
		]);
	});

	test("sorts by prior desc then relPath asc and truncates to the limit", () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/z.md", card("Z", "workflow", "low", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "workflow", "critical", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/m.md", card("M", "workflow", "low", ["cache"]));

		const results = recallSolutionCandidates({ repoRoot: repo, query: "cache", limit: 2 });

		expect(results).toHaveLength(2);
		expect(results[0].relPath).toBe("docs/solutions/workflow/a.md");
		// m.md and z.md tie on prior; path asc wins
		expect(results[1].relPath).toBe("docs/solutions/workflow/m.md");
	});

	test("keeps malformed cards with prior 0 and malformed true", () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/good.md", card("Good", "workflow", "high", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/bad.md", "no frontmatter here");

		const results = recallSolutionCandidates({ repoRoot: repo, query: "cache" });

		const bad = results.find((r) => r.relPath.endsWith("bad.md"));
		expect(bad).toBeDefined();
		expect(bad?.prior).toBe(0);
		expect(bad?.malformed).toBe(true);
	});

	test("uses the body fallback for a card with sparse frontmatter", () => {
		const repo = makeRepo();
		writeCard(
			repo,
			"docs/solutions/workflow/body.md",
			["---", "title: Sparse", "category: workflow", "severity: medium", "tags: []", "---", "", "The cache widget invalidation matters."].join("\n"),
		);

		const results = recallSolutionCandidates({ repoRoot: repo, query: "cache widget" });

		expect(results[0].prior).toBeCloseTo(0.3 + 0.3, 10);
	});

	test("returns [] when docs/solutions is missing or empty", () => {
		const repo = makeRepo();
		expect(recallSolutionCandidates({ repoRoot: repo, query: "cache" })).toEqual([]);

		mkdirSync(path.join(repo, "docs", "solutions"), { recursive: true });
		expect(recallSolutionCandidates({ repoRoot: repo, query: "cache" })).toEqual([]);
	});

	test("drops symlinks that escape docs/solutions instead of reading them", () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/safe.md", card("Safe", "workflow", "high", ["cache"]));

		const outside = path.join(repo, "outside.md");
		writeFileSync(outside, card("Evil", "workflow", "critical", ["cache"]), "utf8");
		symlinkSync(outside, path.join(repo, "docs", "solutions", "workflow", "evil.md"));

		const results = recallSolutionCandidates({ repoRoot: repo, query: "cache" });

		expect(results.map((r) => r.relPath)).toEqual(["docs/solutions/workflow/safe.md"]);
	});

	test("returns one candidate per file with the parsed frontmatter attached", () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("Alpha", "workflow", "high", ["cache", "widget"]));

		const [candidate] = recallSolutionCandidates({ repoRoot: repo, query: "cache" });

		expect(candidate.path).toBe(path.join(repo, "docs/solutions/workflow/a.md"));
		expect(candidate.frontmatter.title).toBe("Alpha");
		expect(candidate.frontmatter.severity).toBe("high");
		expect(candidate.malformed).toBe(false);
	});
});

describe("solution-recall — extractKeywords", () => {
	test("lowercases and strips punctuation", () => {
		expect(extractKeywords("Widget, CACHE! (Invalidation).")).toEqual([
			"widget",
			"cache",
			"invalidation",
		]);
	});

	test("drops tokens shorter than three characters", () => {
		expect(extractKeywords("a of to be abc def")).toEqual(["abc", "def"]);
	});

	test("drops common stopwords", () => {
		expect(extractKeywords("the quick brown fox and the lazy dog")).toEqual([
			"quick",
			"brown",
			"fox",
			"lazy",
			"dog",
		]);
	});

	test("dedupes repeated tokens", () => {
		expect(extractKeywords("cache cache cache widget")).toEqual([
			"cache",
			"widget",
		]);
	});

	test("caps output at 24 tokens", () => {
		const tokens = Array.from({ length: 40 }, (_, index) => `token${index}`);
		const result = extractKeywords(tokens.join(" "));

		expect(result).toHaveLength(24);
		expect(result[0]).toBe("token0");
		expect(result[23]).toBe("token23");
	});

	test("returns [] for empty and whitespace-only input", () => {
		expect(extractKeywords("")).toEqual([]);
		expect(extractKeywords("   \n\t ")).toEqual([]);
	});
});
