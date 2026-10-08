// Unit 6 — compaction-guard wiring: turn_end snapshot capture + one-shot
// request nudge, session_before_compact cancel integration, lifecycle reset,
// invalid-mode warning, and the Pi 0.76 shape-drift fail-open.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest, JevRuntime } from "../extensions/ce-core/jev/types.js";
import {
	COMPACTION_LOG_FILE,
	getCurrentContextSnapshot,
	resetAllSessionState,
	sessionStateSize,
} from "../extensions/ce-core/compaction-guard/store.js";
import { resetPedstackState } from "../extensions/ce-core/commands/pedstack.js";
import ceCoreExtension, {
	__setCompactionGuardJevFactory,
} from "../extensions/ce-core/index.js";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";
import { testFeatures } from "./helpers/feature-config.js";

const SESSION = "sid-compaction";

let root: string;

interface CapturedPi {
	tools: Array<{ name: string }>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
}

function register(): CapturedPi {
	const pi: CapturedPi = { tools: [], handlers: new Map() };
	ceCoreExtension({
		registerTool(definition: { name: string }) {
			pi.tools.push(definition);
		},
		on(event: string, handler: (event: any, ctx: any) => any) {
			const list = pi.handlers.get(event) ?? [];
			list.push(handler);
			pi.handlers.set(event, list);
		},
		registerCommand() {
			// no-op
		},
	} as never);
	return pi;
}

function configureCompaction(
	mode: "off" | "shadow" | "enforce",
	live = false,
): void {
	setStartupFeaturesForTests(
		testFeatures({
			stageGate: { mode: "off" },
			driftGuard: { mode: "off" },
			compactionGuard: { mode, live },
		}),
	);
}

interface Ctx {
	cwd: string;
	hasUI: boolean;
	ui: { notify(message: string): void };
	sessionManager: Record<string, unknown>;
	getContextUsage(): { tokens: number | null; contextWindow: number; percent?: number | null };
	model: { contextWindow: number };
	notifications: string[];
}

function makeCtx(
	over: { hasUI?: boolean; usage?: { tokens: number | null; contextWindow: number } } = {},
): Ctx {
	const notifications: string[] = [];
	return {
		cwd: root,
		hasUI: over.hasUI ?? false,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionId: () => SESSION },
		getContextUsage: () =>
			over.usage ?? { tokens: 112_500, contextWindow: 128_000, percent: 88 },
		model: { contextWindow: 128_000 },
		notifications,
	};
}

function turnEvent(): unknown {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "work" }] },
		toolResults: [],
	};
}

function compactEvent(
	over: {
		reason?: string;
		willRetry?: boolean;
		tokensBefore?: number;
		reserveTokens?: number;
		isSplitTurn?: boolean;
	} = {},
): unknown {
	return {
		type: "session_before_compact",
		reason: over.reason ?? "threshold",
		willRetry: over.willRetry ?? false,
		preparation: {
			firstKeptEntryId: "e1",
			messagesToSummarize: [
				{ role: "user", content: "implement the unit" },
				{ role: "assistant", content: [{ type: "text", text: "working" }] },
			],
			turnPrefixMessages: [],
			isSplitTurn: over.isSplitTurn ?? true,
			tokensBefore: over.tokensBefore ?? 112_500,
			previousSummary: "earlier summary",
			settings: {
				enabled: true,
				reserveTokens: over.reserveTokens ?? 16_384,
				keepRecentTokens: 20_000,
			},
		},
		branchEntries: [],
		startIndex: 0,
		endIndex: 2,
		signal: { aborted: false },
	};
}

function answering(
	values: Partial<Record<string, number>> = {},
): (request: JevRequest) => { exitCode: number; stdout: string; stderr: string } {
	const defaults: Record<string, number> = {
		task_switch: 1,
		meaningful_boundary: 1,
		history_need: 0,
		mid_operation: 0,
	};
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			answers[id] = {
				type: "noul",
				noul: values[id] ?? defaults[id] ?? 1,
				confidence: 0.9,
			};
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
			stderr: "",
		};
	};
}

async function invokeTurnEnd(pi: CapturedPi, ctx: Ctx): Promise<void> {
	for (const handler of pi.handlers.get("turn_end") ?? []) {
		await handler(turnEvent(), ctx);
	}
}

async function invokeCompact(
	pi: CapturedPi,
	event: unknown,
	ctx: Ctx,
): Promise<unknown> {
	let result: unknown;
	for (const handler of pi.handlers.get("session_before_compact") ?? []) {
		const next = await handler(event, ctx);
		if (next) result = next;
	}
	return result;
}

async function invokeSession(
	pi: CapturedPi,
	event: string,
	ctx: Ctx,
): Promise<void> {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler({ type: event }, ctx);
	}
}

async function readLog(): Promise<string> {
	try {
		return await fs.readFile(path.join(root, COMPACTION_LOG_FILE), "utf8");
	} catch {
		return "";
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-wiring-"));
	configureCompaction("shadow");
	resetAllSessionState();
});

afterEach(async () => {
	setStartupFeaturesForTests(null);
	__setCompactionGuardJevFactory(null);
	resetAllSessionState();
	resetPedstackState();
	await fs.rm(root, { recursive: true, force: true });
});

describe("mode gating", () => {
	test("off does no handler work and never calls Jev", async () => {
		configureCompaction("off");
		const pi = register();
		const jev = createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) });
		__setCompactionGuardJevFactory(() => jev);
		const ctx = makeCtx();

		await invokeTurnEnd(pi, ctx);
		const result = await invokeCompact(pi, compactEvent(), ctx);
		expect(result).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
		expect(getCurrentContextSnapshot()).toBeNull();
		expect(existsSync(path.join(root, COMPACTION_LOG_FILE))).toBe(false);
	});

	test("shadow never cancels and logs the would-be defer", async () => {
		configureCompaction("shadow", true);
		const pi = register();
		const jev = createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) });
		__setCompactionGuardJevFactory(() => jev);
		const ctx = makeCtx();

		const result = await invokeCompact(pi, compactEvent(), ctx);
		expect(result).toBeUndefined();
		const lines = (await readLog()).trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.mode).toBe("shadow");
		expect(parsed.action).toBe("defer");
		expect(parsed.source).toBe("jev");
	});

	test("shadow without LIVE makes no live Jev call", async () => {
		const pi = register();
		const jev = createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) });
		__setCompactionGuardJevFactory(() => jev);
		const result = await invokeCompact(pi, compactEvent(), makeCtx());
		expect(result).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
		expect(JSON.parse((await readLog()).trim())).toMatchObject({
			action: "allow",
			source: "deterministic",
		});
	});

	test("enforce cancels only when every guard passes", async () => {
		configureCompaction("enforce");
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) }),
		);
		const result = await invokeCompact(pi, compactEvent(), makeCtx());
		expect(result).toEqual({ cancel: true });
	});

	test("enforce allows a clean boundary", async () => {
		configureCompaction("enforce");
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering() }),
		);
		expect(await invokeCompact(pi, compactEvent(), makeCtx())).toBeUndefined();
	});

	for (const [name, event] of [
		["manual", compactEvent({ reason: "manual" })],
		["overflow", compactEvent({ reason: "overflow" })],
		["retry", compactEvent({ willRetry: true })],
		["overage past budget", compactEvent({ tokensBefore: 111_616 + 3_000 })],
	] as const) {
		test(`${name} never cancels`, async () => {
			configureCompaction("enforce");
			const pi = register();
			const jev = createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) });
			__setCompactionGuardJevFactory(() => jev);
			expect(await invokeCompact(pi, event, makeCtx())).toBeUndefined();
			expect(jev.calls).toHaveLength(0);
		});
	}

	test("a Pi 0.76-shaped event with no reason fails open", async () => {
		configureCompaction("enforce");
		const pi = register();
		const jev = createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) });
		__setCompactionGuardJevFactory(() => jev);
		const legacy = compactEvent() as Record<string, unknown>;
		delete legacy.reason;
		delete legacy.willRetry;
		expect(await invokeCompact(pi, legacy, makeCtx())).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});

	test("a throwing guard leaves stock behavior", async () => {
		configureCompaction("enforce");
		const pi = register();
		const throwing: JevRuntime = {
			decide() {
				throw new Error("jev down");
			},
		};
		__setCompactionGuardJevFactory(() => throwing);
		await expect(
			invokeCompact(pi, compactEvent(), makeCtx()),
		).resolves.toBeUndefined();
	});
});

describe("turn_end snapshot and request nudge", () => {
	test("captures the usage snapshot without notifying below the request tier", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		const ctx = makeCtx({ hasUI: true, usage: { tokens: 65_000, contextWindow: 100_000 } });
		await invokeTurnEnd(pi, ctx);
		expect(getCurrentContextSnapshot()?.tokens).toBe(65_000);
		expect(ctx.notifications).toHaveLength(0);
	});

	test("request tier nudges once per episode from turn_end", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		const ctx = makeCtx({ hasUI: true, usage: { tokens: 95_000, contextWindow: 100_000 } });
		await invokeTurnEnd(pi, ctx);
		await invokeTurnEnd(pi, ctx);
		expect(ctx.notifications).toHaveLength(1);

		await invokeSession(pi, "session_compact", ctx);
		await invokeTurnEnd(pi, ctx);
		expect(ctx.notifications).toHaveLength(2);
	});

	test("the compaction hook never notifies", async () => {
		configureCompaction("enforce");
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) }),
		);
		const ctx = makeCtx({ hasUI: true });
		await invokeCompact(pi, compactEvent(), ctx);
		expect(ctx.notifications).toHaveLength(0);
	});
});

describe("session lifecycle", () => {
	test("session_compact resets the episode and stamps the compaction", async () => {
		configureCompaction("enforce");
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ mid_operation: 1 }) }),
		);
		const ctx = makeCtx();
		await invokeCompact(pi, compactEvent(), ctx);

		await invokeSession(pi, "session_compact", ctx);
		// Re-defer is possible again: the budget was reset by the compaction.
		await invokeCompact(pi, compactEvent(), ctx);
		expect(sessionStateSize()).toBe(1);
	});

	test("session_shutdown clears in-memory state", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		const ctx = makeCtx({
			hasUI: true,
			usage: { tokens: 120_000, contextWindow: 128_000 },
		});
		await invokeTurnEnd(pi, ctx);
		expect(sessionStateSize()).toBeGreaterThan(0);
		await invokeSession(pi, "session_shutdown", ctx);
		expect(sessionStateSize()).toBe(0);
		expect(getCurrentContextSnapshot()).toBeNull();
	});

});
