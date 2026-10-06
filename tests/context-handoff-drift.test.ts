// Unit 5 — drift completion block wired into `context_handoff save`/`validate`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DRIFT_RECORD_TTL_MS, THRESHOLDS_VERSION } from "../extensions/ce-core/drift/combine.js";
import type { DriftRecord, DriftStatus } from "../extensions/ce-core/drift/store.js";
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

function degradedStatus(over: Partial<DriftStatus> = {}): DriftStatus {
	return {
		schema: 1,
		stage: STAGE,
		sessionKey: SESSION,
		thresholdsVersion: THRESHOLDS_VERSION,
		degraded: true,
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
		readStatus: async () => null,
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

	test("enforce + failClosed with no record and no status is allowed", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({ failClosed: true, readRecord: async () => null }),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
		expect(handoffWritten()).toBe(true);
	});

	test("enforce + failClosed blocks a fresh degraded status", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				failClosed: true,
				readStatus: async () => degradedStatus(),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toContain("drift status is unknown");
		expect(result.blocker).toContain("02-plan.status.json");
		expect(result.blocker).toContain("PEDSTACK_DRIFT_GUARD_FAILCLOSED=1");
		expect(handoffWritten()).toBe(false);
	});

	test("enforce + failClosed allows a fresh non-degraded status", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				failClosed: true,
				readStatus: async () => degradedStatus({ degraded: false }),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("enforce + failClosed fail-open matrix (all allowed)", async () => {
		const expired = new Date(
			NOW.getTime() - DRIFT_RECORD_TTL_MS - 1,
		).toISOString();
		const rows: { name: string; status: DriftStatus }[] = [
			{
				name: "expired status",
				status: degradedStatus({ updatedAt: expired }),
			},
			{
				name: "session mismatch",
				status: degradedStatus({ sessionKey: "other" }),
			},
			{
				name: "unknown-session",
				status: degradedStatus({ sessionKey: "unknown-session" }),
			},
			{
				name: "old thresholds version",
				status: degradedStatus({ thresholdsVersion: 1 }),
			},
		];
		for (const row of rows) {
			const tool = createContextHandoffTool({
				drift: makeOptions({
					failClosed: true,
					sessionKey: () =>
						row.name === "unknown-session" ? "unknown-session" : SESSION,
					readStatus: async () => row.status,
				}),
			});
			const result = await tool.execute(saveInput());
			expect({ name: row.name, blocker: result.blocker }).toEqual({
				name: row.name,
				blocker: undefined,
			});
		}
	});

	test("enforce + failClosed allows when the status reader throws", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				failClosed: true,
				readStatus: async () => {
					throw new Error("boom");
				},
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
	});

	test("a v1 strong record cannot block after the thresholds bump", async () => {
		const tool = createContextHandoffTool({
			drift: makeOptions({
				failClosed: true,
				readRecord: async () => strongRecord({ thresholdsVersion: 1 }),
				readStatus: async () => degradedStatus({ thresholdsVersion: 1 }),
			}),
		});
		const result = await tool.execute(saveInput());
		expect(result.blocker).toBeUndefined();
		expect(handoffWritten()).toBe(true);
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
