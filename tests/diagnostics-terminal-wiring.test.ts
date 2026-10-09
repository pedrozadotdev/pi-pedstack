import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import ceCoreExtension from "../extensions/ce-core/index";
import { setActiveStage } from "../extensions/ce-core/utils/active-stage";
import { __resetDiagnosticsForTests, shutdownDiagnostics, startDiagnosticStage } from "../extensions/ce-core/diagnostics";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";

const roots: string[] = [];
const priorDiagnosticPath = process.env.PEDSTACK_DIAGNOSTICS_FILE;
afterEach(async () => {
	delete process.env.PEDSTACK_DIAGNOSTICS_FILE;
	if (priorDiagnosticPath !== undefined) process.env.PEDSTACK_DIAGNOSTICS_FILE = priorDiagnosticPath;
	setStartupFeaturesForTests(null);
	setActiveStage(null);
	await shutdownDiagnostics();
	await __resetDiagnosticsForTests();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function createPiMock() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		registerTool() {},
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand() {},
		sendUserMessage() {},
		appendEntry() {},
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
	};
	return { pi, handlers };
}

describe("terminal diagnostics event wiring", () => {
	test("completes only after a successful, non-skipped 06-docsync stage gate", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pedstack-terminal-diagnostics-"));
		roots.push(root);
		const file = path.join(root, "run.jsonl");
		process.env.PEDSTACK_DIAGNOSTICS_FILE = file;
		await __resetDiagnosticsForTests();
		const { pi, handlers } = createPiMock();
		ceCoreExtension(pi as never);
		const onToolEnd = handlers.get("tool_execution_end")?.at(-1);
		expect(onToolEnd).toBeDefined();

		await startDiagnosticStage("06-docsync");
		setActiveStage("03-work");
		await onToolEnd?.({
			type: "tool_execution_end", toolCallId: "wrong-stage-gate", toolName: "stage_gate", isError: false,
			result: { details: { stage: "06-docsync", verdict: "accept", action: "none", skipped: false } },
		}, {});
		setActiveStage("06-docsync");
		const acceptedDocsyncGate: Extract<ExtensionEvent, { type: "tool_execution_end" }> = {
			type: "tool_execution_end",
			toolCallId: "terminal-gate-1",
			toolName: "stage_gate", isError: false,
			result: { details: { stage: "06-docsync", verdict: "accept", action: "none", skipped: false } },
		};
		await onToolEnd?.(acceptedDocsyncGate, {});
		await startDiagnosticStage("06-docsync");
		const skippedDocsyncGate: Extract<ExtensionEvent, { type: "tool_execution_end" }> = {
			type: "tool_execution_end",
			toolCallId: "terminal-gate-2",
			toolName: "stage_gate", isError: false,
			result: { details: { stage: "06-docsync", verdict: "accept", action: "none", skipped: true } },
		};
		await onToolEnd?.(skippedDocsyncGate, {});
		await shutdownDiagnostics();

		const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.event === "workflow_complete")).toHaveLength(1);
		expect(rows.filter((row) => row.event === "stage_end").map((row) => row.outcome)).toEqual(["success", "interrupted"]);
		expect(rows.at(-1)).toMatchObject({ event: "stage_end", stage: "06-docsync", outcome: "interrupted" });
	});
});
