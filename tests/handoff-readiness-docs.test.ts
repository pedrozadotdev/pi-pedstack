// Handoff readiness — vocabulary and operator docs (plan Unit 7).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("Unit 7 — CONTEXT.md vocabulary", () => {
	test("documents the Handoff readiness section and its terms", () => {
		const context = readFileSync(path.join(repoRoot, "CONTEXT.md"), "utf8");
		expect(context).toContain("## Handoff readiness (#10)");
		for (const term of [
			"Handoff readiness",
			"Dimension",
			"Verdict",
			"Correction",
			"Thresholds version",
			"Degraded",
			"Shadow mode",
		]) {
			expect(context).toContain(term);
		}
	});
});

describe("Unit 7 — README operator surface", () => {
	test("documents the readiness mode and fail-closed config keys", () => {
		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		expect(readme).toContain("features.handoffReadiness");
		expect(readme).toContain('"off" | "shadow" | "enforce"');
		expect(readme).toContain('"handoffReadiness": { "mode": "enforce", "failClosed": false }');
	});
});
