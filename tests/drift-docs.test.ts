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

describe("Unit 6 — corrected drift semantics in docs", () => {
	test("README drops the shipped-divergence text and documents the .status.json marker", () => {
		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		expect(readme).not.toContain("no fresh Jev record");
		expect(readme).not.toContain("FORBIDDEN_STRONG");
		expect(readme).toContain(".status.json");
		expect(readme).toMatch(/degraded/);
	});

	test("CONTEXT documents the drift-status term and removes the fail-closed gap", () => {
		const context = readFileSync(path.join(repoRoot, "CONTEXT.md"), "utf8");
		expect(context).toContain("Drift status");
		expect(context).toContain("supporting-only");
		expect(context).not.toContain("Fail-closed gap");
		expect(context).not.toContain("Shipped divergence");
	});

	test("AGENTS documents the narrowed fail-closed rule and no stale known limitation", () => {
		const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
		expect(agents).toContain(".status.json");
		expect(agents).toMatch(/degraded/);
		expect(agents).not.toContain("known limitation: it cannot distinguish");
	});
});
