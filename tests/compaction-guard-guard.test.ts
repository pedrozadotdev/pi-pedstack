// Unit 4 — compaction-guard orchestration: ordered short-circuits, the hard
// guards, signature reuse, the per-session cap, one bounded Jev call, and the
// enforce-agnostic defer decision. All I/O injected; no live Jev process.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import {
	MAX_CONSECUTIVE_DEFERS,
	MAX_JEV_CALLS_PER_SESSION,
	OVERAGE_TOKENS,
} from "../extensions/ce-core/compaction-guard/facts.js";
import {
	createCompactionGuard,
	type CompactionGuard,
	type CompactionGuardDeps,
	type CompactionGuardInput,
} from "../extensions/ce-core/compaction-guard/guard.js";
import {
	getOrCreateSessionState,
	resetAllSessionState,
	type CompactionLogRecord,
} from "../extensions/ce-core/compaction-guard/store.js";
import type { CompactionDimensionId } from "../extensions/ce-core/compaction-guard/types.js";

const SESSION = "sid-1";
const NOW = new Date("2026-10-06T01:00:00.000Z");

const GOOD: Record<CompactionDimensionId, number> = {
	task_switch: 1,
	meaningful_boundary: 1,
	history_need: 0,
	mid_operation: 0,
};

let root: string;

function baseInput(over: Partial<CompactionGuardInput> = {}): CompactionGuardInput {
	return {
		repoRoot: root,
		reason: "threshold",
		willRetry: false,
		tokensBefore: 112_500,
		contextWindow: 128_000,
		reserveTokens: 16_384,
		isSplitTurn: true,
		recentEntries: ["implemented unit 4"],
		priorSummary: "earlier summary",
		...over,
	};
}

interface Harness {
	guard: CompactionGuard;
	jev: ReturnType<typeof createFakeJevRuntime>;
	logs: CompactionLogRecord[];
	setValues(values: Partial<Record<CompactionDimensionId, number>>): void;
	setError(): void;
	state: ReturnType<typeof getOrCreateSessionState>;
}

function makeGuard(over: Partial<CompactionGuardDeps> = {}): Harness {
	let values: Record<CompactionDimensionId, number> = { ...GOOD };
	let failing = false;
	const logs: CompactionLogRecord[] = [];

	const jev = createFakeJevRuntime({
		handler: (request: JevRequest) => {
			if (failing) throw new Error("jev unavailable");
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(request.questions)) {
				answers[id] = {
					type: "noul",
					noul: values[id as CompactionDimensionId],
					confidence: 0.9,
				};
			}
			return {
				exitCode: 0,
				stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
				stderr: "",
			};
		},
	});

	const guard = createCompactionGuard({
		mode: "enforce",
		live: true,
		sessionKey: () => SESSION,
		createJev: () => jev,
		now: () => NOW,
		logRecord: (_repoRoot, record) => {
			logs.push(record);
		},
		...over,
	});

	return {
		guard,
		jev,
		logs,
		setValues(next) {
			values = { ...GOOD, ...next };
		},
		setError() {
			failing = true;
		},
		state: getOrCreateSessionState(SESSION),
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-guard-"));
	resetAllSessionState();
});

afterEach(async () => {
	resetAllSessionState();
	await fs.rm(root, { recursive: true, force: true });
});

describe("ordered short-circuits (no Jev call, logged)", () => {
	const cases: Array<[string, Partial<CompactionGuardInput>, Partial<Record<CompactionDimensionId, number>>]> = [
		["manual reason", { reason: "manual" }, {}],
		["overflow reason", { reason: "overflow" }, {}],
		["unknown reason", { reason: "something-else" }, {}],
		["retry after overflow", { willRetry: true }, {}],
		["unknown window", { contextWindow: null }, {}],
		["overage above budget", { tokensBefore: 111_616 + OVERAGE_TOKENS + 1 }, {}],
		["overage below zero", { tokensBefore: 100_000 }, {}],
	];

	for (const [name, input, values] of cases) {
		test(`${name} → deterministic allow`, async () => {
			const harness = makeGuard();
			harness.setValues(values);
			const result = await harness.guard.evaluate(baseInput(input));
			expect(result.action).toBe("allow");
			expect(result.source).toBe("deterministic");
			expect(result.jevCalled).toBe(false);
			expect(harness.jev.calls).toHaveLength(0);
			expect(harness.logs).toHaveLength(1);
			expect(harness.logs[0].outcome?.reason).toBeDefined();
		});
	}

	test("defer budget exhausted → deterministic allow", async () => {
		const harness = makeGuard();
		harness.state.consecutiveDefers = MAX_CONSECUTIVE_DEFERS;
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("allow");
		expect(result.source).toBe("deterministic");
		expect(harness.jev.calls).toHaveLength(0);
	});

	test("pressure below the notice floor → deterministic allow", async () => {
		const harness = makeGuard();
		const result = await harness.guard.evaluate(
			baseInput({ contextWindow: 10_000, reserveTokens: 6_000, tokensBefore: 4_500 }),
		);
		expect(result.action).toBe("allow");
		expect(result.source).toBe("deterministic");
		expect(harness.jev.calls).toHaveLength(0);
	});

	test("off mode is ignored and never logs or calls Jev", async () => {
		const harness = makeGuard({ mode: "off" });
		const result = await harness.guard.evaluate(baseInput());
		expect(result.ignored).toBe(true);
		expect(harness.jev.calls).toHaveLength(0);
		expect(harness.logs).toHaveLength(0);
	});
});

describe("fresh Jev judgment", () => {
	test("a good boundary allows and resets the defer streak", async () => {
		const harness = makeGuard();
		harness.state.consecutiveDefers = 1;
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("allow");
		expect(result.source).toBe("jev");
		expect(result.jevCalled).toBe(true);
		expect(harness.state.consecutiveDefers).toBe(0);
	});

	test("a mid-operation cut defers and increments the streak", async () => {
		const harness = makeGuard();
		harness.setValues({ mid_operation: 1 });
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("defer");
		expect(result.source).toBe("jev");
		expect(harness.state.consecutiveDefers).toBe(1);
	});

	test("a degraded Jev answer never defers", async () => {
		const harness = makeGuard();
		harness.setError();
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("allow");
		expect(result.source).toBe("degraded");
		expect(harness.logs[0].source).toBe("degraded");
	});
});

describe("reuse and cap", () => {
	test("an unchanged signature reuses the fresh jev attribution", async () => {
		const harness = makeGuard();
		const first = await harness.guard.evaluate(baseInput());
		const second = await harness.guard.evaluate(baseInput());
		expect(harness.jev.calls).toHaveLength(1);
		expect(second.reused).toBe(true);
		expect(second.source).toBe("jev");
		expect(second.dimensions).toEqual(first.dimensions);
	});

	test("reusing a defer consumes the defer budget", async () => {
		const harness = makeGuard();
		harness.setValues({ mid_operation: 1 });
		await harness.guard.evaluate(baseInput());
		expect(harness.state.consecutiveDefers).toBe(1);
		await harness.guard.evaluate(baseInput());
		expect(harness.state.consecutiveDefers).toBe(2);
		const third = await harness.guard.evaluate(baseInput());
		expect(third.action).toBe("allow");
		expect(third.source).toBe("deterministic");
	});

	test("a changed signature calls Jev again", async () => {
		const harness = makeGuard();
		await harness.guard.evaluate(baseInput());
		await harness.guard.evaluate(
			baseInput({ recentEntries: ["different work"] }),
		);
		expect(harness.jev.calls).toHaveLength(2);
	});

	test("the per-session cap yields deterministic allow with no more Jev calls", async () => {
		const harness = makeGuard();
		for (let index = 0; index < MAX_JEV_CALLS_PER_SESSION; index++) {
			await harness.guard.evaluate(
				baseInput({ recentEntries: [`turn ${index}`] }),
			);
		}
		expect(harness.jev.calls).toHaveLength(MAX_JEV_CALLS_PER_SESSION);
		const capped = await harness.guard.evaluate(
			baseInput({ recentEntries: ["one more"] }),
		);
		expect(capped.action).toBe("allow");
		expect(capped.source).toBe("deterministic");
		expect(harness.jev.calls).toHaveLength(MAX_JEV_CALLS_PER_SESSION);
	});

	test("shadow without LIVE makes no Jev call and never defers", async () => {
		const harness = makeGuard({ mode: "shadow", live: false });
		harness.setValues({ mid_operation: 1 });
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("allow");
		expect(result.source).toBe("deterministic");
		expect(result.jevCalled).toBe(false);
		expect(harness.jev.calls).toHaveLength(0);
	});

	test("shadow with LIVE computes the defer without applying it", async () => {
		const harness = makeGuard({ mode: "shadow", live: true });
		harness.setValues({ mid_operation: 1 });
		const result = await harness.guard.evaluate(baseInput());
		expect(result.action).toBe("defer");
		expect(result.source).toBe("jev");
		expect(result.jevCalled).toBe(true);
	});

	test("the log carries the calibration fields", async () => {
		const harness = makeGuard({ mode: "shadow", live: true });
		await harness.guard.evaluate(baseInput());
		const log = harness.logs[0];
		expect(log.mode).toBe("shadow");
		expect(log.reason).toBe("threshold");
		expect(log.tier).toBe("recommend");
		expect(log.overageTokens).toBe(884);
		expect(log.jevCalled).toBe(true);
	});
});
