// Unit 1 — CI type-check floor: the workflow and package script must stay present.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("Unit 1 — CI type-check floor", () => {
	test("the test workflow runs bun x tsc --noEmit", () => {
		expect(read(".github/workflows/test.yml")).toContain("bun x tsc --noEmit");
	});

	test("package.json exposes a typecheck script", () => {
		const pkg = JSON.parse(read("package.json")) as {
			scripts?: Record<string, string>;
		};
		expect(pkg.scripts?.typecheck).toBe("bun x tsc --noEmit");
	});
});
