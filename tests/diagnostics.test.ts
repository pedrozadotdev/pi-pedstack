import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiagnostics } from "../extensions/ce-core/diagnostics";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outputPath(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pedstack-diagnostics-"));
	roots.push(root);
	return path.join(root, "run.jsonl");
}

describe("local diagnostics", () => {
	test("is disabled when no output file is selected", async () => {
		const diagnostics = createDiagnostics({ file: "" });
		expect(diagnostics.enabled()).toBe(false);
		await diagnostics.record({ feature: "jev", event: "decision" });
	});

	test("writes only allowlisted fields and excludes sensitive values", async () => {
		const file = outputPath();
		const diagnostics = createDiagnostics({ file, runId: "run-test", now: () => 0 });
		await diagnostics.record({
			feature: "jev", event: "decision", stage: "02-plan", role: "sota",
			outcome: "success", durationMs: 12, inputTokens: 25,
			usageKnown: false,
			// These model-authored/untrusted additions are intentionally ignored.
			prompt: "SECRET-PROMPT", path: "/private/project", token: "SECRET-TOKEN",
		} as never);
		const line = readFileSync(file, "utf8");
		expect(line).not.toContain("SECRET-");
		expect(line).not.toContain("/private/");
		expect(JSON.parse(line)).toMatchObject({ feature: "jev", usageKnown: false, inputTokens: 25 });
	});

	test("marks replaced stages and shutdown as interrupted and numbers repeats", async () => {
		const file = outputPath();
		let now = 10;
		const diagnostics = createDiagnostics({ file, runId: "r", now: () => now });
		const first = await diagnostics.startStage("02-plan");
		now = 15;
		const second = await diagnostics.startStage("02-plan");
		expect(first.attempt).toBe(1);
		expect(second.attempt).toBe(2);
		now = 30;
		await diagnostics.shutdown();
		const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.map((row) => row.event)).toEqual([
			"stage_start", "stage_interrupted", "stage_start", "stage_interrupted",
		]);
		expect(rows[1].durationMs).toBe(5);
		expect(rows[3].durationMs).toBe(15);
	});
});
