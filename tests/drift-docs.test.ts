// Unit 7 — drift vocabulary and operator docs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("Unit 7 — CONTEXT.md vocabulary", () => {
	test("documents the Stage drift section and its terms", () => {
		const context = readFileSync(path.join(repoRoot, "CONTEXT.md"), "utf8");
		expect(context).toContain("## Stage drift (#8)");
		for (const term of [
			"Stage drift",
			"Drift dimension",
			"Drift verdict",
			"Drift correction",
			"Unresolved drift",
			"Turn signature",
			"Drift mode",
			"Drift record",
			"Shadow promotion",
		]) {
			expect(context).toContain(term);
		}
	});
});

describe("Unit 7 — README operator surface", () => {
	test("documents the drift mode and fail-closed env vars", () => {
		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		expect(readme).toContain("PEDSTACK_DRIFT_GUARD");
		expect(readme).toContain("PEDSTACK_DRIFT_GUARD_FAILCLOSED");
		expect(readme).toContain("off | shadow | enforce");
	});

	test("documents the record path, delete-to-clear override, and restart note", () => {
		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		expect(readme).toContain("drift/<stage>.json");
		expect(readme).toContain("delete");
		expect(readme).toContain("restart");
	});

	test("documents the shadow promotion gate and calibrate-before-enforce rule", () => {
		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		expect(readme).toContain("drift.jsonl");
		expect(readme).toContain("calibrate");
	});
});
