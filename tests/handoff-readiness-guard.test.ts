// Handoff readiness — guard orchestration and precedence (plan Unit 5).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import {
	THRESHOLDS_VERSION,
	canonicalizeState,
	hashCanonical,
	normalizeState,
} from "../extensions/ce-core/handoff-readiness/combine.js";
import {
	createReadinessGuard,
	type ReadinessGuardDeps,
} from "../extensions/ce-core/handoff-readiness/guard.js";
import {
	pairSlug,
	writeReadinessRecord,
} from "../extensions/ce-core/handoff-readiness/store.js";
import type {
	ReadinessGuardInput,
	ReadinessLogRecord,
	ReadinessRecord,
	ReadinessState,
} from "../extensions/ce-core/handoff-readiness/types.js";

const GOOD: Record<string, number> = {
	continuation_sufficiency: 1,
	next_step_clarity: 1,
	verification_support: 1,
	blocking_open_decisions: 0,
	history_need: 0,
};

let root: string;

function baseState(over: Partial<ReadinessState> = {}): ReadinessState {
	return {
		currentStage: "02-plan",
		nextStage: "03-work",
		handoffMarkdown:
			"## Current Task\nContinue from 02-plan to 03-work.\n",
		currentTask: "Continue from 02-plan to 03-work.",
		nextMinimalStep:
			"Implement Unit 5 in extensions/ce-core/handoff-readiness/guard.ts",
		verification: "bun test tests/handoff-readiness-guard.test.ts: 12 pass",
		blocker: "",
		openDecisions: [],
		currentTruth: ["Plan is frozen."],
		invalidatedAssumptions: [],
		activeFiles: [],
		recentlyAccessedFiles: [],
		artifacts: {
			plan: "docs/plans/2026-10-06-semantic-handoff-readiness-validation.md",
		},
		activeRules: ["TDD: RED then GREEN."],
		...over,
	};
}

function input(over: Partial<ReadinessGuardInput> = {}): ReadinessGuardInput {
	return {
		repoRoot: root,
		currentStage: "02-plan",
		nextStage: "03-work",
		state: baseState(),
		...over,
	};
}

function hashOf(state: ReadinessState): string {
	return hashCanonical(canonicalizeState(normalizeState(state)));
}

function recordFor(
	state: ReadinessState,
	over: Partial<ReadinessRecord> = {},
): ReadinessRecord {
	return {
		schema: 1,
		pair: pairSlug("02-plan", "03-work"),
		hash: hashOf(state),
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: "continue",
		source: "jev",
		dimensions: [],
		corrections: [],
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

function answering(
	values: Record<string, number> = GOOD,
	confidence = 0.9,
): (request: JevRequest) => {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			answers[id] = { type: "noul", noul: values[id] ?? 1, confidence };
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
			stderr: "",
		};
	};
}

interface Harness {
	guard: ReturnType<typeof createReadinessGuard>;
	jev: ReturnType<typeof createFakeJevRuntime>;
	writes: ReadinessRecord[];
	logs: ReadinessLogRecord[];
}

function makeGuard(over: Partial<ReadinessGuardDeps> = {}): Harness {
	const jev = createFakeJevRuntime({ handler: answering() });
	const writes: ReadinessRecord[] = [];
	const logs: ReadinessLogRecord[] = [];
	const guard = createReadinessGuard({
		mode: "shadow",
		failClosed: false,
		createJev: () => jev,
		now: () => new Date("2026-10-06T00:00:00.000Z"),
		fileExists: () => true,
		writeRecord: (_repoRoot: string, record: ReadinessRecord) => {
			writes.push(record);
			return "memory";
		},
		logRecord: (_repoRoot: string, record: ReadinessLogRecord) => {
			logs.push(record);
		},
		...over,
	});
	return { guard, jev, writes, logs };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-readiness-guard-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("Unit 5 — gating scope", () => {
	test("off mode is never gated and writes nothing", async () => {
		const harness = makeGuard({ mode: "off" });
		const result = await harness.guard.evaluate(input());
		expect(result).toEqual({ gated: false, allowed: true });
		expect(harness.writes).toEqual([]);
		expect(harness.jev.calls).toEqual([]);
	});

	test("a same-stage checkpoint and an unknown stage are not gated", async () => {
		for (const over of [
			{ nextStage: "02-plan" },
			{ currentStage: "not-a-stage" },
		]) {
			const harness = makeGuard();
			const result = await harness.guard.evaluate(input(over));
			expect({ over, result }).toEqual({
				over,
				result: { gated: false, allowed: true },
			});
			expect(harness.writes).toEqual([]);
		}
	});

	test("a completion save is gated and writes a record and a log line", async () => {
		const harness = makeGuard();
		const result = await harness.guard.evaluate(input());
		expect(result.gated).toBe(true);
		expect(harness.writes).toHaveLength(1);
		expect(harness.logs).toHaveLength(1);
	});
});

describe("Unit 5 — pre-pass precedence", () => {
	test("a missing file forces improve_handoff before freshness reuse", async () => {
		const state = baseState({ activeFiles: ["src/live.ts"] });
		let readCalls = 0;
		const harness = makeGuard({
			fileExists: () => false,
			readRecord: async () => {
				readCalls += 1;
				return recordFor(state);
			},
		});
		const result = await harness.guard.evaluate(input({ state }));
		expect(result.verdict).toBe("improve_handoff");
		expect(result.allowed).toBe(true);
		expect(result.corrections?.[0].message).toContain("no longer exists");
		expect(readCalls).toBe(0);
		expect(harness.jev.calls).toEqual([]);
	});

	test("contains escaping paths before any existence probe", async () => {
		let probes = 0;
		const harness = makeGuard({
			fileExists: () => {
				probes += 1;
				return true;
			},
		});
		const state = baseState({ activeFiles: ["../../etc/passwd"] });
		const result = await harness.guard.evaluate(input({ state }));
		expect(probes).toBe(0);
		expect(result.verdict).toBe("improve_handoff");
		expect(result.corrections?.[0].message).toContain("no longer exists");
	});

	test("a throwing fileExists is treated as existing", async () => {
		const harness = makeGuard({
			fileExists: () => {
				throw new Error("stat failed");
			},
		});
		const state = baseState({ activeFiles: ["src/x.ts"] });
		const result = await harness.guard.evaluate(input({ state }));
		expect(result.verdict).toBe("continue");
		expect(result.corrections ?? []).toEqual([]);
	});

	test("a bare /ped-next state skips Jev and derives deterministic improve", async () => {
		const harness = makeGuard();
		const state = baseState({ nextMinimalStep: "/ped-next" });
		const result = await harness.guard.evaluate(input({ state }));
		expect(result.verdict).toBe("improve_handoff");
		expect(result.source).toBe("deterministic");
		expect(result.allowed).toBe(true);
		expect(harness.jev.calls).toEqual([]);
	});
});

describe("Unit 5 — freshness reuse", () => {
	test("an unchanged state calls the fake runtime exactly once", async () => {
		const harness = makeGuard({ readRecord: undefined, writeRecord: undefined });
		const first = await harness.guard.evaluate(input());
		const second = await harness.guard.evaluate(input());
		expect(first.verdict).toBe("continue");
		expect(second.verdict).toBe("continue");
		expect(harness.jev.requests).toHaveLength(1);
	});

	test("changing the next stage invalidates the record", async () => {
		const harness = makeGuard({ readRecord: undefined, writeRecord: undefined });
		await harness.guard.evaluate(input());
		await harness.guard.evaluate(input({ nextStage: "04-review" }));
		expect(harness.jev.requests).toHaveLength(2);
	});

	test("a degraded record is never reused", async () => {
		const state = baseState();
		await writeReadinessRecord(root, recordFor(state, { source: "degraded" }));
		const harness = makeGuard();
		await harness.guard.evaluate(input({ state }));
		expect(harness.jev.requests).toHaveLength(1);
	});

	test("a deterministic record is never reused", async () => {
		const state = baseState();
		await writeReadinessRecord(
			root,
			recordFor(state, { source: "deterministic" }),
		);
		const harness = makeGuard();
		await harness.guard.evaluate(input({ state }));
		expect(harness.jev.requests).toHaveLength(1);
	});
});

describe("Unit 5 — mode mapping", () => {
	const failing = baseState();

	test("shadow allows a non-continue verdict with a warning and structured outcome", async () => {
		const harness = makeGuard({
			createJev: () =>
				createFakeJevRuntime({ handler: answering({ ...GOOD, next_step_clarity: 0 }) }),
		});
		const result = await harness.guard.evaluate(input({ state: failing }));
		expect(result.allowed).toBe(true);
		expect(result.warning).toBeString();
		expect(result.verdict).toBe("improve_handoff");
		expect(result.dimensions?.length).toBe(5);
		expect(harness.writes).toHaveLength(1);
		expect(harness.logs).toHaveLength(1);
	});

	test("enforce blocks a non-continue verdict with a blocker naming the correction", async () => {
		const harness = makeGuard({
			mode: "enforce",
			createJev: () =>
				createFakeJevRuntime({ handler: answering({ ...GOOD, next_step_clarity: 0 }) }),
		});
		const result = await harness.guard.evaluate(input({ state: failing }));
		expect(result.allowed).toBe(false);
		expect(result.blocker).toContain("Next Minimal Step names no concrete file");
		expect(harness.writes).toHaveLength(1);
		expect(harness.logs).toHaveLength(1);
	});
});

describe("Unit 5 — degraded and fail-open", () => {
	function throwingJev(): ReturnType<typeof createFakeJevRuntime> {
		return createFakeJevRuntime({ handler: () => new Error("jev outage") });
	}

	test("a degraded result is allowed in shadow and in enforce without failClosed", async () => {
		for (const mode of ["shadow", "enforce"] as const) {
			const harness = makeGuard({ mode, createJev: throwingJev });
			const result = await harness.guard.evaluate(input());
			expect({ mode, allowed: result.allowed }).toEqual({
				mode,
				allowed: true,
			});
			expect(result.source).toBe("degraded");
			expect(result.warning).toBeString();
		}
	});

	test("enforce + failClosed blocks a degraded result", async () => {
		const harness = makeGuard({
			mode: "enforce",
			failClosed: true,
			createJev: throwingJev,
		});
		const result = await harness.guard.evaluate(input());
		expect(result.allowed).toBe(false);
		expect(result.blocker).toBeString();
	});

	test("an injected writeRecord that throws leaves the save allowed", async () => {
		const harness = makeGuard({
			mode: "enforce",
			writeRecord: () => {
				throw new Error("disk full");
			},
		});
		const result = await harness.guard.evaluate(input());
		expect(result.allowed).toBe(true);
		expect(result.verdict).toBe("continue");
	});
});
