// Unit 4 — drift guard orchestration: deterministic pre-pass, dedupe, cap,
// one bounded Jev call, streak persistence, and correction delivery.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import {
	DRIFT_QUESTION_IDS,
	DRIFT_RECORD_TTL_MS,
	MAX_DRIFT_JEV_CALLS_PER_SESSION,
	THRESHOLDS_VERSION,
} from "../extensions/ce-core/drift/combine.js";
import {
	createDriftGuard,
	type DriftGuard,
	type DriftGuardDeps,
	type DriftGuardInput,
} from "../extensions/ce-core/drift/guard.js";
import {
	shouldBlockCompletion,
	type DriftLogRecord,
	type DriftRecord,
	type DriftStatus,
} from "../extensions/ce-core/drift/store.js";
import type { DriftDimensionId } from "../extensions/ce-core/drift/types.js";

const STAGE = "03-work";
const SESSION = "sid-1";
const NOW = new Date("2026-10-06T01:00:00.000Z");

const GOOD: Record<DriftDimensionId, number> = {
	in_stage_scope: 1,
	forbidden_work: 0,
	scope_drift: 0,
	progress: 1,
};

let root: string;

function assistant(content: unknown[]): any {
	return {
		role: "assistant",
		content,
		api: "x",
		provider: "x",
		model: "m",
		usage: {},
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolCall(id: string, name: string, args: unknown): any {
	return { type: "toolCall", id, name, arguments: args };
}

function turn(over: Partial<DriftGuardInput> = {}): DriftGuardInput {
	return {
		repoRoot: root,
		stage: STAGE,
		message: assistant([{ type: "text", text: "Implementing the unit." }]),
		toolResults: [],
		turnIndex: 1,
		...over,
	};
}

interface Harness {
	guard: DriftGuard;
	jev: ReturnType<typeof createFakeJevRuntime>;
	records: Map<string, DriftRecord>;
	statuses: Map<string, DriftStatus>;
	logs: DriftLogRecord[];
	calls: { count: number };
	setValues(values: Partial<Record<DriftDimensionId, number>>): void;
	setError(): void;
}

function makeGuard(over: Partial<DriftGuardDeps> = {}): Harness {
	let values: Record<DriftDimensionId, number> = { ...GOOD };
	let failing = false;
	const records = new Map<string, DriftRecord>();
	const statuses = new Map<string, DriftStatus>();
	const logs: DriftLogRecord[] = [];
	const calls = { count: 0 };

	const jev = createFakeJevRuntime({
		handler: (request: JevRequest) => {
			if (failing) throw new Error("jev unavailable");
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(request.questions)) {
				answers[id] = { type: "noul", noul: values[id as DriftDimensionId], confidence: 0.9 };
			}
			return {
				exitCode: 0,
				stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
				stderr: "",
			};
		},
	});

	const guard = createDriftGuard({
		mode: "enforce",
		failClosed: false,
		sessionKey: () => SESSION,
		createJev: () => jev,
		now: () => NOW,
		readRecord: async (_repoRoot: string, stage: string) =>
			records.get(stage) ?? null,
		writeRecord: async (_repoRoot: string, record: DriftRecord) => {
			records.set(record.stage, record);
			return "memory";
		},
		clearRecord: async (_repoRoot: string, stage: string) => {
			records.delete(stage);
		},
		writeStatus: async (_repoRoot: string, status: DriftStatus) => {
			statuses.set(status.stage, status);
		},
		logRecord: (_repoRoot: string, record: DriftLogRecord) => {
			logs.push(record);
		},
		...over,
	});

	return {
		guard,
		jev,
		records,
		statuses,
		logs,
		calls,
		setValues(next) {
			values = { ...GOOD, ...next };
		},
		setError() {
			failing = true;
		},
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "drift-guard-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("pre-pass short-circuits", () => {
	test("unknown stage is deterministic no_drift with no Jev call", async () => {
		const harness = makeGuard();
		const result = await harness.guard.evaluate(
			turn({ stage: "09-nope" }),
		);
		expect(result.verdict).toBe("no_drift");
		expect(result.source).toBe("deterministic");
		expect(harness.jev.calls).toHaveLength(0);
		expect(harness.records.size).toBe(0);
	});

	test("trivial turn makes zero Jev calls", async () => {
		const harness = makeGuard();
		const result = await harness.guard.evaluate(
			turn({ message: assistant([]) }),
		);
		expect(result.verdict).toBe("no_drift");
		expect(result.source).toBe("deterministic");
		expect(harness.jev.calls).toHaveLength(0);
	});

	test("off mode is ignored and never calls Jev", async () => {
		const harness = makeGuard({ mode: "off" });
		const result = await harness.guard.evaluate(turn());
		expect(result.ignored).toBe(true);
		expect(harness.jev.calls).toHaveLength(0);
	});
});

describe("dedupe and cap", () => {
	test("identical signatures call Jev once; a new signature calls again", async () => {
		const harness = makeGuard();
		const first = turn();
		await harness.guard.evaluate(first);
		await harness.guard.evaluate(first);
		expect(harness.jev.calls).toHaveLength(1);

		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "Different work." }]) }),
		);
		expect(harness.jev.calls).toHaveLength(2);
	});

	test("dedupe reuse is deterministic with reason unchanged turn", async () => {
		const harness = makeGuard();
		const first = turn();
		await harness.guard.evaluate(first);
		const reused = await harness.guard.evaluate(first);
		expect(reused.source).toBe("deterministic");
		expect(reused.reason).toContain("unchanged");
	});

	test("per-session cap yields deterministic no_drift without more Jev calls", async () => {
		const harness = makeGuard({ mode: "shadow" });
		for (let index = 0; index < MAX_DRIFT_JEV_CALLS_PER_SESSION; index++) {
			await harness.guard.evaluate(
				turn({
					message: assistant([{ type: "text", text: `turn ${index}` }]),
					turnIndex: index,
				}),
			);
		}
		expect(harness.jev.calls).toHaveLength(MAX_DRIFT_JEV_CALLS_PER_SESSION);

		const capped = await harness.guard.evaluate(
			turn({
				message: assistant([{ type: "text", text: "one more" }]),
				turnIndex: 999,
			}),
		);
		expect(capped.verdict).toBe("no_drift");
		expect(capped.source).toBe("deterministic");
		expect(capped.reason).toContain("cap");
		expect(harness.jev.calls).toHaveLength(MAX_DRIFT_JEV_CALLS_PER_SESSION);
	});
});

describe("shadow vs enforce", () => {
	test("shadow logs a drifting turn but writes no record or correction", async () => {
		const harness = makeGuard({ mode: "shadow" });
		harness.setValues({ in_stage_scope: 0.1 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("mild_drift");
		expect(result.correction).toBeUndefined();
		expect(result.recorded).toBe(false);
		expect(harness.records.size).toBe(0);
		expect(harness.logs).toHaveLength(1);
	});

	test("shadow strong verdict writes no record (no seeded enforce read)", async () => {
		const harness = makeGuard({ mode: "shadow" });
		harness.setValues({ forbidden_work: 0.9 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("strong_drift");
		expect(harness.records.size).toBe(0);
	});

	test("enforce mild stores one pending correction and a record", async () => {
		const harness = makeGuard();
		harness.setValues({ in_stage_scope: 0.1 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("mild_drift");
		expect(result.recorded).toBe(true);
		expect(result.correction).toContain(STAGE);
		const pending = harness.guard.getAndClearCorrection();
		expect(pending).toBe(result.correction);
		expect(harness.guard.getAndClearCorrection()).toBeUndefined();
	});

	test("newest correction overwrites the pending one across stages", async () => {
		const harness = makeGuard();
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "one" }]) }),
		);
		const first = harness.guard.getAndClearCorrection();
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(
			turn({
				stage: "04-5-debug",
				message: assistant([{ type: "text", text: "two" }]),
			}),
		);
		const second = harness.guard.getAndClearCorrection();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
	});
});

describe("streak transition and strong persistence", () => {
	test("strong_work alone is strong and its record blocks a completion read", async () => {
		const harness = makeGuard();
		harness.setValues({ forbidden_work: 0.9 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("strong_drift");
		const record = harness.records.get(STAGE);
		expect(record?.verdict).toBe("strong_drift");
		expect(
			shouldBlockCompletion(record ?? null, STAGE, SESSION, NOW),
		).toBe(true);
	});

	test("two consecutive mild jev turns escalate to strong", async () => {
		const harness = makeGuard();
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "mild one" }]) }),
		);
		expect(harness.records.get(STAGE)?.verdict).toBe("mild_drift");
		const second = await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "mild two" }]) }),
		);
		expect(second.verdict).toBe("strong_drift");
		expect(harness.records.get(STAGE)?.verdict).toBe("strong_drift");
	});

	test("strong then degraded keeps the record blocking", async () => {
		const harness = makeGuard();
		harness.setValues({ forbidden_work: 0.9 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "strong turn" }]) }),
		);
		harness.setError();
		const degraded = await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "outage" }]) }),
		);
		expect(degraded.source).toBe("degraded");
		expect(harness.records.get(STAGE)?.verdict).toBe("strong_drift");
		expect(
			shouldBlockCompletion(
				harness.records.get(STAGE) ?? null,
				STAGE,
				SESSION,
				NOW,
			),
		).toBe(true);
	});

	test("strong then a trivial deterministic turn still blocks", async () => {
		const harness = makeGuard();
		harness.setValues({ forbidden_work: 0.9 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "strong turn" }]) }),
		);
		await harness.guard.evaluate(turn({ message: assistant([]) }));
		expect(
			shouldBlockCompletion(
				harness.records.get(STAGE) ?? null,
				STAGE,
				SESSION,
				NOW,
			),
		).toBe(true);
	});

	test("strong clears after two jev no_drift turns", async () => {
		const harness = makeGuard();
		harness.setValues({ forbidden_work: 0.9 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "strong" }]) }),
		);
		harness.setValues({});
		const first = await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "calm one" }]) }),
		);
		expect(first.verdict).toBe("strong_drift");
		expect(harness.records.get(STAGE)?.consecutiveNoDrift).toBe(1);
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "calm two" }]) }),
		);
		expect(harness.records.has(STAGE)).toBe(false);
	});

	test("strong clears in one jev no_drift turn that writes the stage artifact", async () => {
		const harness = makeGuard();
		harness.setValues({ forbidden_work: 0.9 });
		await harness.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "strong" }]) }),
		);
		harness.setValues({});
		await harness.guard.evaluate(
			turn({
				message: assistant([
					{ type: "text", text: "writing the artifact" },
					toolCall("c1", "write", { path: "tests/drift-guard.test.ts" }),
				]),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "c1",
						toolName: "write",
						content: [],
						isError: false,
						timestamp: 1,
					},
				],
			}),
		);
		expect(harness.records.has(STAGE)).toBe(false);
	});
});

describe("record shape", () => {
	test("a persisted record carries the frozen fields and thresholds version", async () => {
		const harness = makeGuard();
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(turn());
		const record = harness.records.get(STAGE)!;
		expect(record.schema).toBe(1);
		expect(record.thresholdsVersion).toBe(THRESHOLDS_VERSION);
		expect(record.sessionKey).toBe(SESSION);
		expect(record.source).toBe("jev");
		expect(record.triggered).toContain("in_stage_scope");
		expect(record.updatedAt).toBe(NOW.toISOString());
	});
});

describe("drift status marker (enforce only)", () => {
	test("enforce writes a non-degraded status for a jev verdict", async () => {
		const harness = makeGuard();
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(turn());
		const status = harness.statuses.get(STAGE);
		expect(status).toEqual({
			schema: 1,
			stage: STAGE,
			sessionKey: SESSION,
			thresholdsVersion: THRESHOLDS_VERSION,
			degraded: false,
			updatedAt: NOW.toISOString(),
		});
	});

	test("enforce writes degraded:true on a Jev outage without touching the record", async () => {
		const harness = makeGuard();
		harness.records.set(STAGE, {
			schema: 1,
			stage: STAGE,
			sessionKey: SESSION,
			turnIndex: 0,
			signature: "old",
			thresholdsVersion: THRESHOLDS_VERSION,
			verdict: "strong_drift",
			source: "jev",
			triggered: ["forbidden_work"],
			consecutiveMild: 0,
			consecutiveNoDrift: 0,
			updatedAt: NOW.toISOString(),
		});
		harness.setError();
		const result = await harness.guard.evaluate(turn());
		expect(result.source).toBe("degraded");
		expect(harness.statuses.get(STAGE)?.degraded).toBe(true);
		expect(harness.records.get(STAGE)?.verdict).toBe("strong_drift");
	});

	test("enforce writes degraded:true on invalid (degraded) answers", async () => {
		const harness = makeGuard({
			createJev: () =>
				createFakeJevRuntime({
					handler: () => ({
						exitCode: 0,
						stdout: JSON.stringify({ answers: {}, model: "typesafe/jev" }),
						stderr: "",
					}),
				}),
		});
		const result = await harness.guard.evaluate(turn());
		expect(result.source).toBe("degraded");
		expect(harness.statuses.get(STAGE)?.degraded).toBe(true);
	});

	test("deterministic short-circuits write no status", async () => {
		const unknown = makeGuard();
		await unknown.guard.evaluate(turn({ stage: "09-nope" }));
		expect(unknown.statuses.size).toBe(0);

		const trivial = makeGuard();
		await trivial.guard.evaluate(turn({ message: assistant([]) }));
		expect(trivial.statuses.size).toBe(0);

		const reused = makeGuard();
		const first = turn();
		await reused.guard.evaluate(first);
		await reused.guard.evaluate(first);
		expect(reused.statuses.size).toBe(1);

		const capped = makeGuard({ mode: "shadow" });
		for (let index = 0; index < MAX_DRIFT_JEV_CALLS_PER_SESSION; index++) {
			await capped.guard.evaluate(
				turn({
					message: assistant([{ type: "text", text: `turn ${index}` }]),
					turnIndex: index,
				}),
			);
		}
		await capped.guard.evaluate(
			turn({ message: assistant([{ type: "text", text: "one more" }]) }),
		);
		expect(capped.statuses.size).toBe(0);
	});

	test("shadow writes neither a status nor a record", async () => {
		const harness = makeGuard({ mode: "shadow" });
		harness.setValues({ in_stage_scope: 0.1 });
		await harness.guard.evaluate(turn());
		expect(harness.statuses.size).toBe(0);
		expect(harness.records.size).toBe(0);
	});

	test("a status-write failure does not fail the turn or suppress the log", async () => {
		const harness = makeGuard({
			writeStatus: () => {
				throw new Error("disk full");
			},
		});
		harness.setValues({ in_stage_scope: 0.1 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("mild_drift");
		expect(harness.logs).toHaveLength(1);
	});
});

describe("prior lookup only from a fresh jev record", () => {
	test("a stale strong record does not block a fresh mild turn", async () => {
		const harness = makeGuard();
		harness.records.set(STAGE, {
			schema: 1,
			stage: STAGE,
			sessionKey: SESSION,
			turnIndex: 0,
			signature: "old",
			thresholdsVersion: THRESHOLDS_VERSION,
			verdict: "strong_drift",
			source: "jev",
			triggered: ["forbidden_work"],
			consecutiveMild: 0,
			consecutiveNoDrift: 0,
			updatedAt: new Date(
				NOW.getTime() - DRIFT_RECORD_TTL_MS - 1,
			).toISOString(),
		});
		harness.setValues({ in_stage_scope: 0.1 });
		const result = await harness.guard.evaluate(turn());
		expect(result.verdict).toBe("mild_drift");
		expect(DRIFT_QUESTION_IDS).toContain("progress");
	});
});
