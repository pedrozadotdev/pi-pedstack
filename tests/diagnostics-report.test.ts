import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareDiagnosticsReports, readDiagnosticsReport, summarizeDiagnostics } from "../extensions/ce-core/diagnostics-report";

describe("diagnostics reports", () => {
	test("reports nearest-rank quantiles, sample variance and unknown usage", () => {
		const [row] = summarizeDiagnostics([
			{ stage: "02-plan", feature: "jev", durationMs: 1, processDurationMs: 0.5, processInvoked: true, usageKnown: false, outcome: "success" },
			{ stage: "02-plan", feature: "jev", durationMs: 2, processDurationMs: 1.5, processInvoked: true, usageKnown: false, outcome: "failure" },
		]);
		expect(row?.durationMs).toEqual({ median: 1.5, p95: 2, variance: 0.5 });
		expect(row?.processInvocations).toBe(2);
		expect(row?.usage).toBe("unknown");
		expect(row?.outcomes).toEqual({ success: 1, failure: 1 });
	});

	test("marks partial token usage when a run exposes it only on some events", () => {
		const [row] = summarizeDiagnostics([
			{ feature: "model", usageKnown: true, inputTokens: 8, outputTokens: 3 },
			{ feature: "model", usageKnown: false },
		]);
		expect(row?.usage).toEqual({ knownObservations: 1, inputTokens: 8, outputTokens: 3, partial: true });
		expect(row?.costUsd).toBe("unknown");
	});

	test("counts process failures without exposing unrecognized grouping labels", () => {
		const report = summarizeDiagnostics([
			{ feature: "SECRET_PROMPT", stage: "SECRET_STAGE", processInvoked: true, outcome: "failure", searchCalls: 1 },
		]);
		expect(report[0]?.group).toBe("unknown/unknown");
		expect(report[0]?.processExitCodes).toEqual({ unknown: 1 });
		expect(report[0]?.searchCalls).toBe(1);
	});

	test("rejects malformed lines without echoing their contents", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pedstack-report-"));
		const file = path.join(dir, "bad.jsonl");
		writeFileSync(file, '{"safe":true}\nSECRET_PROMPT\n');
		try {
			await expect(readDiagnosticsReport(file)).rejects.toThrow("line 2");
			await expect(readDiagnosticsReport(file)).rejects.not.toThrow("SECRET_PROMPT");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("compares matching groups and keeps unavailable measurements unknown", () => {
		const before = summarizeDiagnostics([{ feature: "jev", stage: "02-plan", durationMs: 10, usageKnown: false }]);
		const after = summarizeDiagnostics([{ feature: "jev", stage: "02-plan", durationMs: 8, usageKnown: true, inputTokens: 40, outputTokens: 10 }]);
		const [row] = compareDiagnosticsReports(before, after);
		expect(row?.durationMs).toEqual({ before: 10, after: 8, deltaMs: -2, deltaPercent: -20 });
		expect(row?.beforeUsage).toBe("unknown");
		expect(row?.afterUsage).toMatchObject({ inputTokens: 40, outputTokens: 10 });
	});
});
