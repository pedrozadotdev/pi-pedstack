// Deterministic complexity facts extraction (plan Unit 3). Pure parser over a
// bounded diff plus guarded untracked-file reads; the git runner is injected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	excerptDiff,
	extractComplexityFacts,
	isSecretShaped,
	redactSecrets,
	stdlibCapabilities,
	tagProtectedComplexity,
} from "../extensions/ce-core/overengineering/facts.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "overengineering");

let root: string;

async function write(rel: string, content: string | Uint8Array): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

function failGit(): Promise<string> {
	return Promise.reject(new Error("git boom"));
}

function fixturePatch(): Promise<string> {
	return fs.readFile(path.join(FIXTURES, "diff-unjustified-dependency.patch"), "utf8");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-facts-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering facts (Unit 3)", () => {
	test("parses added dependencies and undeclared external imports", async () => {
		const facts = await extractComplexityFacts({
			repoRoot: root,
			diffText: await fixturePatch(),
			untrackedFiles: [],
			runGit: failGit,
		});
		expect(facts.newDependencies).toEqual(["axios", "left-pad", "lodash"]);
	});

	test("parses addedFiles and addedImportsExports, sorted", async () => {
		const facts = await extractComplexityFacts({
			repoRoot: root,
			diffText: await fixturePatch(),
			untrackedFiles: [],
			runGit: failGit,
		});
		expect(facts.addedFiles).toEqual([
			"package.json",
			"src/service.ts",
			"tests/service.test.ts",
		]);
		expect(facts.addedImportsExports).toEqual([
			"src/service.ts:export const run = async () => {",
			'src/service.ts:import axios from "axios";',
			'src/service.ts:import fs from "node:fs";',
			'src/service.ts:import { helper } from "./helper";',
			'tests/service.test.ts:import { expect, test } from "bun:test";',
		]);
	});

	test("tags every one of the six protected categories", () => {
		const tags = tagProtectedComplexity(
			[
				"tests/a.test.ts",
				"src/auth/token.ts",
				"src/validation/schema.ts",
				"src/logger.ts",
				"db/migrations/001-init.ts",
				"src/errors.ts",
			],
			["throw new Error('boom')"],
		);
		expect(new Set(tags)).toEqual(
			new Set([
				"validation",
				"security",
				"observability",
				"migration",
				"error_handling",
				"tests",
			]),
		);
	});

	test("guards untracked files: path, extension, size, and binary", async () => {
		await write("node_modules/left-pad/index.js", "module.exports = 1;\n");
		await write("assets/logo.png", "not really a png");
		await write("big.txt", "x".repeat(300 * 1024));
		await write("bin.dat", Buffer.from([0x61, 0x00, 0x62]));
		await write("keep.ts", "export const keep = 1;\n");

		const facts = await extractComplexityFacts({
			repoRoot: root,
			diffText: "",
			untrackedFiles: [
				"node_modules/left-pad/index.js",
				"assets/logo.png",
				"big.txt",
				"bin.dat",
				"keep.ts",
			],
			runGit: failGit,
		});
		expect(facts.addedFiles).toEqual(["keep.ts"]);
		expect(facts.truncated.untrackedSkipped).toBe(4);
	});

	test("redacts secret-shaped lines", () => {
		expect(isSecretShaped('const key = "AKIAIOSFODNN7EXAMPLE";')).toBe(true);
		expect(isSecretShaped("const x = 1;")).toBe(false);
		expect(redactSecrets('a = "AKIAIOSFODNN7EXAMPLE"')).not.toContain("AKIA");
		expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz012345')).toContain("[REDACTED]");
	});

	test("redacts a secret inside the diff excerpt", () => {
		const diff = `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const k = "AKIAIOSFODNN7EXAMPLE";\n`;
		expect(excerptDiff(diff)).not.toContain("AKIA");
	});

	test("caps lists at 50 with explicit counts", async () => {
		const lines = ["diff --git a/package.json b/package.json", "+++ b/package.json", "@@ -0,0 +1,60 @@"];
		for (let index = 0; index < 60; index++) {
			lines.push(`+    "dep-${String(index).padStart(2, "0")}": "^1.0.0",`);
		}
		const facts = await extractComplexityFacts({
			repoRoot: root,
			diffText: lines.join("\n"),
			untrackedFiles: [],
			runGit: failGit,
		});
		expect(facts.newDependencies).toHaveLength(50);
		expect(facts.truncated.newDependencies).toBe(10);
	});

	test("excerpts head+tail with a marker and records raw vs excerpted bytes", async () => {
		const head = "HEAD-" + "h".repeat(2000);
		const tail = "t".repeat(2000) + "-TAIL";
		const diff = `diff --git a/src/big.ts b/src/big.ts\n+++ b/src/big.ts\n@@ -1 +1 @@\n+${head}${tail}\n`;
		const excerpt = excerptDiff(diff);
		expect(excerpt).toContain("…[truncated");
		expect(excerpt.startsWith("diff --git")).toBe(true);
		expect(excerpt).toContain("-TAIL");
		expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(6144);

		const facts = await extractComplexityFacts({
			repoRoot: root,
			diffText: diff,
			untrackedFiles: [],
			runGit: failGit,
		});
		expect(facts.diffBytes).toBeGreaterThan(facts.diffExcerptBytes);
		expect(facts.diffExcerptBytes).toBe(Buffer.byteLength(excerpt, "utf8"));
	});

	test("applies the global 6 KiB cap across many files", () => {
		const diffs: string[] = [];
		for (let index = 0; index < 10; index++) {
			const body = "x".repeat(2000);
			diffs.push(
				[
					`diff --git a/src/f${index}.ts b/src/f${index}.ts`,
					`+++ b/src/f${index}.ts`,
					"@@ -1 +1 @@",
					`+${body}-${index}`,
				].join("\n"),
			);
		}
		const excerpt = excerptDiff(diffs.join("\n"));
		expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(6144);
	});

	test("a git failure skips every dimension without throwing", async () => {
		const facts = await extractComplexityFacts({ repoRoot: root, runGit: failGit });
		expect(facts.addedFiles).toEqual([]);
		expect(facts.newDependencies).toEqual([]);
		expect(facts.diffBytes).toBe(0);
		expect(facts.skippedDimensions).toEqual([
			{ dimension: "no_unrequested_abstraction", reason: "git_unavailable" },
			{ dimension: "scope_fidelity", reason: "git_unavailable" },
			{ dimension: "complexity_proportionality", reason: "git_unavailable" },
			{ dimension: "dependency_justification", reason: "git_unavailable" },
		]);
	});

	test("the production git commands respect gitignore and HEAD", async () => {
		const seen: string[][] = [];
		await extractComplexityFacts({
			repoRoot: root,
			runGit: (args: string[]) => {
				seen.push(args);
				return Promise.resolve("");
			},
		});

		expect(seen).toEqual([
			["diff", "--no-color", "--unified=0", "HEAD"],
			["ls-files", "--others", "--exclude-standard"],
		]);
	});

	test("stdlibCapabilities covers every builtin in bare and node: form", () => {
		const caps = stdlibCapabilities();
		for (const name of builtinModules) {
			const bare = name.replace(/^node:/, "");
			expect(caps.has(bare)).toBe(true);
			expect(caps.has(`node:${bare}`)).toBe(true);
		}
	});
});
