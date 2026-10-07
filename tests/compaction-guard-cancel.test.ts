// Unit 6 — cancel integration: a fake session_before_compact harness proving
// `{ cancel: true }` appends no compaction, the next check re-invokes the
// handler, and the defer budget terminates the loop (manual/overflow never cancel).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest } from "../extensions/ce-core/jev/types.js";
import {
	MAX_CONSECUTIVE_DEFERS,
} from "../extensions/ce-core/compaction-guard/facts.js";
import {
	resetAllSessionState,
} from "../extensions/ce-core/compaction-guard/store.js";
import ceCoreExtension, {
	__setCompactionGuardJevFactory,
} from "../extensions/ce-core/index.js";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";
import { testFeatures } from "./helpers/feature-config.js";

let root: string;

interface Pi {
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
}

function register(): Pi {
	const pi: Pi = { handlers: new Map() };
	ceCoreExtension({
		registerTool() {},
		on(event: string, handler: (event: any, ctx: any) => any) {
			const list = pi.handlers.get(event) ?? [];
			list.push(handler);
			pi.handlers.set(event, list);
		},
		registerCommand() {},
	} as never);
	return pi;
}

function ctx(): unknown {
	return {
		cwd: root,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "sid-cancel" },
		getContextUsage: () => ({ tokens: 112_500, contextWindow: 128_000 }),
		model: { contextWindow: 128_000 },
	};
}

function event(reason = "threshold"): unknown {
	return {
		type: "session_before_compact",
		reason,
		willRetry: false,
		preparation: {
			firstKeptEntryId: "e1",
			messagesToSummarize: [{ role: "user", content: "work" }],
			turnPrefixMessages: [],
			isSplitTurn: true,
			tokensBefore: 112_500,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
		branchEntries: [],
		signal: { aborted: false },
	};
}

function answering(midOperation: number): (request: JevRequest) => {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			answers[id] = {
				type: "noul",
				noul: id === "mid_operation" ? midOperation : id === "history_need" ? 0 : 1,
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

/** Emulates Pi's `_checkCompaction`: a cancel appends nothing and is re-checked. */
interface Engine {
	checks: number;
	compactions: number;
	invocations: number;
}

async function checkCompaction(
	pi: Pi,
	input: unknown,
	engine: Engine,
): Promise<boolean> {
	engine.checks += 1;
	let result: unknown;
	for (const handler of pi.handlers.get("session_before_compact") ?? []) {
		engine.invocations += 1;
		const next = await handler(input, ctx());
		if (next) result = next;
	}
	if (result && (result as { cancel?: boolean }).cancel) return false;
	engine.compactions += 1;
	return true;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-cancel-"));
	setStartupFeaturesForTests(
		testFeatures({
			stageGate: { mode: "off" },
			driftGuard: { mode: "off" },
			compactionGuard: { mode: "enforce", live: false },
		}),
	);
	resetAllSessionState();
});

afterEach(async () => {
	setStartupFeaturesForTests(null);
	__setCompactionGuardJevFactory(null);
	resetAllSessionState();
	await fs.rm(root, { recursive: true, force: true });
});

describe("cancel integration", () => {
	test("a defer cancels, appends no compaction, and the next check re-invokes", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering(1) }),
		);
		const engine: Engine = { checks: 0, compactions: 0, invocations: 0 };

		const first = await checkCompaction(pi, event(), engine);
		expect(first).toBe(false);
		expect(engine.compactions).toBe(0);
		expect(engine.checks).toBe(1);

		const second = await checkCompaction(pi, event(), engine);
		expect(second).toBe(false);
		expect(engine.checks).toBe(2);
		expect(engine.invocations).toBe(2);
		expect(engine.compactions).toBe(0);
	});

	test("the defer budget terminates the loop and compaction proceeds", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering(1) }),
		);
		const engine: Engine = { checks: 0, compactions: 0, invocations: 0 };

		// Two deferred reschedules, then the budget forces a deterministic allow.
		expect(await checkCompaction(pi, event(), engine)).toBe(false);
		expect(await checkCompaction(pi, event(), engine)).toBe(false);
		expect(await checkCompaction(pi, event(), engine)).toBe(true);
		expect(engine.compactions).toBe(1);
		expect(MAX_CONSECUTIVE_DEFERS).toBe(2);
	});

	test("a clean boundary compacts immediately", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering(0) }),
		);
		const engine: Engine = { checks: 0, compactions: 0, invocations: 0 };
		expect(await checkCompaction(pi, event(), engine)).toBe(true);
		expect(engine.compactions).toBe(1);
	});

	test("manual compaction never cancels", async () => {
		const pi = register();
		__setCompactionGuardJevFactory(() =>
			createFakeJevRuntime({ handler: answering(1) }),
		);
		const engine: Engine = { checks: 0, compactions: 0, invocations: 0 };
		expect(await checkCompaction(pi, event("manual"), engine)).toBe(true);
		expect(engine.compactions).toBe(1);
	});
});
