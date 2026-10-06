// Docs verification — deterministic facts from manifests, locks, and imports
// (plan Unit 2).
import { describe, expect, test } from "bun:test";
import {
	buildFacts,
	classifySpecifier,
	extractExternalSpecifiers,
	parseManifestDeps,
	resolveLockVersion,
} from "../extensions/ce-core/docs-verification/facts.js";
import type { FactsDeps, FactsInput, PackageFact } from "../extensions/ce-core/docs-verification/types.js";

function virtualFs(files: Record<string, string>): FactsDeps {
	return {
		readFile: async (absPath: string) => {
			const value = files[absPath];
			if (value === undefined) throw new Error(`missing ${absPath}`);
			return value;
		},
		exists: (absPath: string) => absPath in files,
	};
}

function input(over: Partial<FactsInput> = {}): FactsInput {
	return {
		phase: "planned",
		unitText: "**Files.**\n\n- create `src/a.ts`\n\nUses `left-pad`.",
		declaredFiles: ["src/a.ts"],
		nearestManifestPath: "/repo/package.json",
		workspaceRoot: "/repo",
		...over,
	};
}

describe("Unit 2 — parseManifestDeps", () => {
	const manifest = {
		dependencies: { typebox: "^1.0.0" },
		peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.74.0" },
		devDependencies: { "bun-types": "^1.3.12" },
	};

	test("includes dependencies and peerDependencies for a non-tooling unit", () => {
		expect(parseManifestDeps(manifest, false)).toEqual([
			{ name: "typebox", version: "^1.0.0", versionUnknown: true, kind: "dependency" },
			{
				name: "@earendil-works/pi-coding-agent",
				version: ">=0.74.0",
				versionUnknown: true,
				kind: "peer",
			},
		]);
	});

	test("includes devDependencies only for a tooling unit", () => {
		const names = parseManifestDeps(manifest, true).map(
			(entry: PackageFact) => entry.name,
		);
		expect(names).toContain("bun-types");
		expect(
			parseManifestDeps(manifest, false).map((e: PackageFact) => e.name),
		).not.toContain(
			"bun-types",
		);
	});

	test("returns empty for malformed or missing manifests", () => {
		expect(parseManifestDeps(null, false)).toEqual([]);
		expect(parseManifestDeps([], false)).toEqual([]);
		expect(parseManifestDeps({ dependencies: "no" }, false)).toEqual([]);
	});
});

describe("Unit 2 — classifySpecifier", () => {
	test("excludes builtins, relative, alias, and URL specifiers", () => {
		for (const specifier of [
			"node:fs",
			"bun:test",
			"./local",
			"../up",
			"~/alias",
			"@/alias",
			"data:text/plain,hi",
		]) {
			expect(classifySpecifier(specifier).external).toBe(false);
		}
	});

	test("includes a bare package specifier and strips subpaths", () => {
		expect(classifySpecifier("left-pad")).toEqual({
			external: true,
			name: "left-pad",
			dynamic: false,
		});
		expect(classifySpecifier("@scope/pkg/sub").name).toBe("@scope/pkg");
	});

	test("marks a string-literal dynamic import as dynamic", () => {
		expect(classifySpecifier('import("left-pad")')).toEqual({
			external: true,
			name: "left-pad",
			dynamic: true,
		});
	});

	test("marks a computed dynamic import as ambiguous", () => {
		const result = classifySpecifier("import(expr)");
		expect(result.external).toBe(false);
		expect(result.ambiguous).toBe(true);
	});
});

describe("Unit 2 — extractExternalSpecifiers", () => {
	test("finds static import, export-from, and require", () => {
		const source = [
			'import x from "a";',
			'export { y } from "b";',
			'const z = require("c");',
			'import "side-effect";',
		].join("\n");
		expect(extractExternalSpecifiers(source)).toEqual([
			"a",
			"b",
			"side-effect",
			"c",
		]);
	});

	test("finds dynamic imports including a computed one", () => {
		const source = 'const a = import("left-pad");\nconst b = import(expr);';
		expect(extractExternalSpecifiers(source)).toEqual([
			'import("left-pad")',
			"import(expr)",
		]);
	});

	test("skips type-only imports", () => {
		const source = 'import type { T } from "type-only";\nimport { v } from "real";';
		expect(extractExternalSpecifiers(source)).toEqual(["real"]);
	});
});

describe("Unit 2 — resolveLockVersion", () => {
	test("resolves a bun.lock entry", () => {
		const text = '{ "dependencies": { "left-pad": ["left-pad@1.3.0", "", {}] } }';
		expect(resolveLockVersion(text, "bun", "left-pad")).toEqual({
			name: "left-pad",
			version: "1.3.0",
			versionUnknown: false,
			kind: "dependency",
		});
	});

	test("resolves a package-lock.json entry", () => {
		const text = JSON.stringify({
			packages: { "node_modules/left-pad": { version: "1.3.0" } },
		});
		expect(resolveLockVersion(text, "npm", "left-pad").version).toBe("1.3.0");
	});

	test("resolves a pnpm-lock.yaml entry", () => {
		const text = "packages:\n\n  /left-pad@1.3.0:\n    resolution: {integrity: sha}\n";
		expect(resolveLockVersion(text, "pnpm", "left-pad").version).toBe("1.3.0");
	});

	test("resolves a yarn.lock entry", () => {
		const text = '"left-pad@^1.0.0":\n  version "1.3.0"\n';
		expect(resolveLockVersion(text, "yarn", "left-pad").version).toBe("1.3.0");
	});

	test("returns versionUnknown for a missing entry", () => {
		expect(resolveLockVersion("{}", "bun", "left-pad").versionUnknown).toBe(true);
		expect(resolveLockVersion("not json", "npm", "left-pad").versionUnknown).toBe(
			true,
		);
	});
});

describe("Unit 2 — buildFacts", () => {
	const manifest = JSON.stringify({
		peerDependencies: { typebox: "^1.0.0" },
	});

	test("planned facts use unit-text names when the declared file does not exist", async () => {
		const deps = virtualFs({ "/repo/package.json": manifest });
		const facts = await buildFacts(
			input({
				unitText: "**Files.**\n\n- create `src/a.ts`\n\nUses `typebox`.",
			}),
			deps,
		);
		expect(facts.declaredFiles).toEqual([{ path: "src/a.ts", exists: false }]);
		expect(facts.packages.map((entry: PackageFact) => entry.name)).toEqual(["typebox"]);
		expect(facts.versionUnknown).toBe(true);
	});

	test("resolves a lock version in precedence order (bun before npm)", async () => {
		const deps = virtualFs({
			"/repo/package.json": manifest,
			"/repo/bun.lock":
				'{ "dependencies": { "typebox": ["typebox@1.1.0", "", {}] } }',
			"/repo/package-lock.json": JSON.stringify({
				packages: { "node_modules/typebox": { version: "9.9.9" } },
			}),
			"/repo/src/a.ts": 'import { Type } from "typebox";',
		});
		const facts = await buildFacts(
			input({ unitText: "**Files.**\n\n- create `src/a.ts`\n\nUses `typebox`." }),
			deps,
		);
		expect(facts.packages).toEqual([
			{ name: "typebox", version: "1.1.0", versionUnknown: false, kind: "peer" },
		]);
		expect(facts.versionUnknown).toBe(false);
	});

	test("observed facts intersect the dependency set and read imports", async () => {
		const deps = virtualFs({
			"/repo/package.json": manifest,
			"/repo/src/a.ts": [
				'import { Type } from "typebox";',
				'import pad from "left-pad";',
				'import fs from "node:fs";',
			].join("\n"),
		});
		const facts = await buildFacts(input({ phase: "observed" }), deps);
		expect(facts.declaredFiles).toEqual([{ path: "src/a.ts", exists: true }]);
		expect(facts.packages.map((entry: PackageFact) => entry.name)).toEqual(["typebox"]);
	});

	test("observed facts fall back to unit text when no file is readable", async () => {
		const deps = virtualFs({ "/repo/package.json": manifest });
		const facts = await buildFacts(
			input({
				phase: "observed",
				unitText: "**Files.**\n\n- create `src/a.ts`\n\nUses `typebox`.",
			}),
			deps,
		);
		expect(facts.packages.map((entry: PackageFact) => entry.name)).toEqual(["typebox"]);
	});

	test("a corrupt manifest yields no manifest facts and never throws", async () => {
		const deps = virtualFs({ "/repo/package.json": "{not json" });
		const facts = await buildFacts(input(), deps);
		expect(facts.packages.map((entry: PackageFact) => entry.name)).toEqual(["left-pad"]);
	});

	test("a unit with no external references yields no packages", async () => {
		const deps = virtualFs({
			"/repo/package.json": manifest,
			"/repo/src/a.ts": 'import fs from "node:fs";\nimport { b } from "./b";',
		});
		const facts = await buildFacts(
			input({ phase: "observed", unitText: "**Files.**\n\n- edit `src/a.ts`" }),
			deps,
		);
		expect(facts.packages).toEqual([]);
		expect(facts.versionUnknown).toBe(false);
	});

	test("valid evidence lines are collected against detected packages", async () => {
		const deps = virtualFs({ "/repo/package.json": manifest });
		const unitText = [
			"**Files.**",
			"",
			"- create `src/a.ts`",
			"",
			"Uses `typebox`.",
			"docs-verified: typebox@^1.0.0 docs/typebox.md",
		].join("\n");
		const facts = await buildFacts(input({ unitText }), deps);
		expect(facts.evidence).toEqual([
			{
				package: "typebox",
				version: "^1.0.0",
				docRef: "docs/typebox.md",
				valid: true,
			},
		]);
	});
});
