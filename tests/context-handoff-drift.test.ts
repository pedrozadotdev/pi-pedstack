// Unit 5 — drift completion block wired into `context_handoff save`/`validate`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DRIFT_RECORD_TTL_MS, THRESHOLDS_VERSION } from "../extensions/ce-core/drift/combine.js";
import type { DriftRecord } from "../extensions/ce-core/drift/store.js";
import {
	createContextHandoffTool,
	type ContextHandoffDriftOptions,
	type ContextHandoffInput,
} from "../extensions/ce-core/tools/context-handoff.js";

const NOW = new Date("2026-10-06T01:00:00.000Z");
const STAGE = "02-plan";
const SESSION = "sid-1";

let root: string;

function strongRecord(over: Partial<DriftRecord> = {}): DriftRecord {
	return {
		schema: 1,
		stage: STAGE,
		sessionKey: SESSION,
		turnIndex: 1,
		signature: "abc",
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: "strong_drift",
		source: "jev",
		triggered: ["forbidden_work"],
		consecutiveMild: 0,
		consecutiveNoDrift: 0,
		updatedAt: NOW.toISOString(),
		...over,
	};
}

function makeOptions(
	over: Partial<ContextHandoffDriftOptions> = {},
): ContextHandoffDriftOptions {
	return {
		mode: "enforce",
		failClosed: false,
		sessionKey: () => SESSION,
		now: () => NOW,
		readRecord: async () => null,
		...over,
	};
}

function saveInput(over: Partial<ContextHandoffInput> = {}): ContextHandoffInput {
	return {
		operation: "save",
		repoRoot: root,
		currentStage: STAGE,
		nextStage: "03-work",
		contextHealth: "good",
		activeFiles: [],
		artifacts: {},
		currentTruth: ["plan is frozen"],
		verification: "bun test: pass",
		...over,
	};
}

function handoffWritten(): boolean {
	return existsSync(
		path.join(root, ".context", "compound-engineering", "handoffs", "latest.md"),
	);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "context-handoff-drift-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("save gating", () => {
	test("no drift option behaves exactly as today", async () => {
		const tool = createContextHandoffTool();
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
		expect(handoffWritten()).toBe(true);
	});

	test("off mode is never gated", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ mode: "off", readRecord: async () => strongRecord() }),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("a same-stage checkpoint is never gated", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ readRecord: async () => strongRecord() }),
		});
		const result = await tool.execute(saveInput({ nextStage: STAGE }));
		expect(result.blocker).toBeUndefined();
	});

	test("enforce blocks a fresh strong record and writes no handoff", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ readRecord: async () => strongRecord() }),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toContain(STAGE);
		expect(result.blocker).toContain("forbidden_work");
		expect(result.blocker).toContain("drift/02-plan.json");
		expect(result.blocker).toContain("PEDSTACK_DRIFT_GUARD=off");
		expect(handoffWritten()).toBe(false);
	});

	test("shadow allows a strong record but surfaces a warning", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				mode: "shadow",
				readRecord: async () => strongRecord(),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
		expect(result.gateWarning ?? "").toContain("drift");
		expect(handoffWritten()).toBe(true);
	});

	test("enforce allows a fresh no_drift or mild record", async () => {
		for (const verdict of ["no_drift", "mild_drift"] as const) {
			const tool = createContextHandoffTool({
				drift: makeOptions({
					readRecord: async () => strongRecord({ verdict }),
				}),
			});
			const result = await tool.execute(saveInput());
			expect({ verdict, blocker: result.blocker }).toEqual({
				verdict,
				blocker: undefined,
			});
		}
	});

	test("a different session is ignored (isolation)", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				readRecord: async () => strongRecord({ sessionKey: "other" }),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("a degraded strong-shaped record is ignored", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				readRecord: async () => strongRecord({ source: "degraded" }),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("an expired strong record is ignored", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				readRecord: async () =>
					strongRecord({
						updatedAt: new Date(
							NOW.getTime() - DRIFT_RECORD_TTL_MS - 1,
						).toISOString(),
					}),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("enforce + failClosed with no record blocks with the degraded message", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ failClosed: true, readRecord: async () => null }),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toContain("drift status is unknown");
		expect(result.blocker).toContain("PEDSTACK_DRIFT_GUARD_FAILCLOSED=1");
		expect(handoffWritten()).toBe(false);
	});

	test("enforce + failClosed false with no record is allowed", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ failClosed: false, readRecord: async () => null }),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});
});

describe("validate advisory", () => {
	test("surfaces a fresh strong record without calling Jev", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ readRecord: async () => strongRecord() }),
		});
		const result = await tool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: STAGE,
		});
		expect(result.drift?.verdict).toBe("strong_drift");
		expect(result.drift?.triggered).toContain("forbidden_work");
	});

	test("returns no drift advisory in off mode", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ mode: "off", readRecord: async () => strongRecord() }),
		});
		const result = await tool.execute({
			operation: "validate",
			repoRoot: root,
			currentStage: STAGE,
		});
		expect(result.drift).toBeUndefined();
	});
});
