import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiagnostics, isDiagnosticVerificationCall, recordSolutionSearch } from "../extensions/ce-core/diagnostics";

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
	test("labels verification calls and automatic searches without persisting command/query data", () => {
		expect(isDiagnosticVerificationCall("bash", { command: "bun test" })).toBe(true);
		expect(isDiagnosticVerificationCall("bash", { command: "cat SECRET_FILE" })).toBe(false);
		expect(isDiagnosticVerificationCall("read", { command: "bun test" })).toBe(false);
		expect(recordSolutionSearch("02-plan", "SECRET QUERY", "automatic")).toMatchObject({
			feature: "solution_search", event: "automatic_search", searchCalls: 1,
		});
	});

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

	test("counts a transition only after the destination stage is entered", async () => {
		const file = outputPath();
		const diagnostics = createDiagnostics({ file, runId: "r" });
		await diagnostics.startStage("04-review");
		await diagnostics.handoff("04-review", "05-learn");
		await diagnostics.shutdown();
		const declinedRows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(declinedRows.find((row) => row.event === "stage_end")).toMatchObject({ outcome: "success", stageTransitions: 0 });
		expect(declinedRows.some((row) => row.event === "stage_transition")).toBe(false);

		const acceptedFile = outputPath();
		const accepted = createDiagnostics({ file: acceptedFile, runId: "r" });
		await accepted.startStage("04-review");
		await accepted.handoff("04-review", "05-learn");
		await accepted.startStage("05-learn");
		await accepted.shutdown();
		const rows = readFileSync(acceptedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.find((row) => row.event === "stage_transition")).toMatchObject({ stage: "05-learn", stageTransitions: 1 });

		const resumedFile = outputPath();
		const resumed = createDiagnostics({ file: resumedFile, runId: "r" });
		await resumed.startStage("04-review");
		await resumed.handoff("04-review", "05-learn");
		await resumed.shutdown(true);
		await resumed.startStage("05-learn");
		await resumed.shutdown();
		const resumedRows = readFileSync(resumedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(resumedRows.find((row) => row.event === "stage_transition")).toMatchObject({ stage: "05-learn", stageTransitions: 1 });
	});

	test("finalizes terminal workflow and drains a burst before shutdown returns", async () => {
		const file = outputPath();
		const diagnostics = createDiagnostics({ file, runId: "r" });
		await diagnostics.startStage("06-docsync");
		for (let index = 0; index < 100; index++) {
			void diagnostics.record({ feature: "model", event: "model_response", modelCalls: 1 });
		}
		await diagnostics.completeWorkflow("06-docsync");
		await diagnostics.shutdown();
		const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.event === "model_response")).toHaveLength(100);
		expect(rows.at(-1)).toMatchObject({ event: "workflow_complete", stage: "06-docsync", outcome: "success" });
		expect(rows.findIndex((row) => row.event === "model_response")).toBeLessThan(rows.findIndex((row) => row.event === "stage_end"));
	});

	test("counts each entered stage in a review-fix loop", async () => {
		const file = outputPath();
		const diagnostics = createDiagnostics({ file, runId: "r" });
		await diagnostics.startStage("04-review");
		await diagnostics.handoff("04-review", "03-work");
		await diagnostics.startStage("03-work");
		await diagnostics.handoff("03-work", "04-review");
		await diagnostics.startStage("04-review");
		await diagnostics.shutdown();
		const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.event === "stage_transition").reduce((sum, row) => sum + row.stageTransitions, 0)).toBe(2);
		expect(rows.filter((row) => row.event === "stage_start" && row.stage === "04-review")).toHaveLength(2);
	});
});
