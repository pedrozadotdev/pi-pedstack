import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";

import * as agyRunner from "../extensions/ce-core/review/agy-runner";
import { parseAgyFindings } from "../extensions/ce-core/review/agy-runner";

const state: { calls: Array<Record<string, unknown>>; fail: boolean; malformedResponse?: string } = { calls: [], fail: false };
let restoreReviewer: (() => void) | undefined;
beforeEach(() => {
	const reviewer = spyOn(agyRunner, "runAgyReviewer").mockImplementation(async (input) => {
		state.calls.push({ ...input });
		if (state.malformedResponse) return parseAgyFindings(state.malformedResponse, input.reviewer);
		if (state.fail) throw new Error("guarded review failed");
		return [];
	});
	restoreReviewer = () => reviewer.mockRestore();
});

import { createMultiReviewerTool } from "../extensions/ce-core/tools/multi-reviewer";

let repoRoot = "";
afterEach(async () => {
	restoreReviewer?.();
	restoreReviewer = undefined;
	if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
	repoRoot = "";
	state.calls = [];
	state.fail = false;
	state.malformedResponse = undefined;
});
async function setup(model: string): Promise<void> {
	repoRoot = `/tmp/pi-ce-agy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
	await writeFile(path.join(repoRoot, ".pi", "pi-pedstack", "config.json"), JSON.stringify({ models: { default: { model: "execution/default-test" }, sota: { model: "execution/sota-test" } }, plan: { model: "stage/plan-test", thinkingLevel: "high", reviewers: [{ model, thinkingLevel: "high" }] } }));
}

describe("Gemini reviewer dispatch", () => {
	test("dispatches the selected exact Gemini identifier through the guarded runner", async () => {
		await setup("provider/gemini-3.8-flash-high");
		await createMultiReviewerTool().execute({ stepName: "02-plan", primaryOutput: "plan text", repoRoot });
		expect(state.calls).toHaveLength(1);
		expect(state.calls[0]?.model).toBe("provider/gemini-3.8-flash-high");
		expect(state.calls[0]?.prompt).toContain("plan text");
		expect(state.calls[0]?.thinkingLevel).toBe("high");
	});

	test("does not persist a success sidecar when the guarded Gemini runner fails", async () => {
		await setup("gemini-3.8-flash-high");
		state.fail = true;
		await expect(createMultiReviewerTool().execute({ stepName: "02-plan", primaryOutput: "plan text", repoRoot })).rejects.toThrow("Review incomplete");
		expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
	});

	test("rejects malformed Gemini findings and leaves the success sidecar absent", async () => {
		await setup("gemini-3.8-flash-high");
		const valid = { severity: "high", summary: "Valid finding", evidence: "source.ts:1", recommendedAction: "Fix it", autofixable: false };
		const invalid = { severity: ["high"], summary: "Malformed finding", evidence: "source.ts:2", recommendedAction: "Fix it", autofixable: false };
		state.malformedResponse = JSON.stringify({ status: "SUCCESS", response: JSON.stringify([valid, invalid]), conversation_id: "c-1" });
		await expect(createMultiReviewerTool().execute({ stepName: "02-plan", primaryOutput: "plan text", repoRoot })).rejects.toThrow("invalid severity");
		expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
	});
});
