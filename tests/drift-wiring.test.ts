// Unit 6 — extension wiring: turn_end detection, one-shot correction,
// session lifecycle, invalid-mode warning, and handoff drift options.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevRequest, JevRuntime } from "../extensions/ce-core/jev/types.js";
import {
	DRIFT_LOG_FILE,
	setCurrentDriftSessionKey,
	writeDriftRecord,
} from "../extensions/ce-core/drift/store.js";
import {
	DRIFT_CORRECTION_HEADING,
	THRESHOLDS_VERSION,
} from "../extensions/ce-core/drift/combine.js";
import {
	setActiveStage,
	clearActiveStage,
} from "../extensions/ce-core/utils/active-stage.js";
import { resetPedstackState } from "../extensions/ce-core/commands/pedstack.js";
import ceCoreExtension, {
	__setDriftJevFactory,
} from "../extensions/ce-core/index.js";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";
import { testFeatures } from "./helpers/feature-config.js";

const SESSION = "sid-wiring";
const STAGE = "03-work";

let root: string;

interface CapturedPi {
	tools: Array<{ name: string; execute: (id: string, params: any) => Promise<any> }>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
}

function makePi(): CapturedPi {
	const tools: CapturedPi["tools"] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	return {
		tools,
		handlers,
	};
}

function register(pi: CapturedPi): void {
	const api = {
		registerTool(definition: { name: string; execute: any }) {
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
	};
	ceCoreExtension(api as never);
}

// Shape pin (source-driven re-check): resolved @earendil-works/pi-coding-agent@0.76.0
// declares `TurnEndEvent` at dist/core/extensions/types.d.ts:495 with
// `message: AgentMessage` (L498) and `toolResults: ToolResultMessage[]` (L499).
// `ctx.sessionManager` is `ReadonlySessionManager`; `getSessionId`/`getLeafId`
// are read shape-guarded by `resolveSessionKey`. Any future shape drift must
// keep yielding a no-op (see the malformed-message test).
function turnEvent(text = "Implementing the unit."): any {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "x",
			provider: "x",
			model: "m",
			usage: {},
			stopReason: "stop",
			timestamp: 1,
		},
		toolResults: [],
	};
}

interface Ctx {
	cwd: string;
	hasUI: boolean;
	ui: { notify(message: string): void };
	sessionManager: Record<string, unknown>;
	notifications: string[];
}

function makeCtx(
	over: Partial<Pick<Ctx, "hasUI" | "sessionManager">> = {},
): Ctx {
	const notifications: string[] = [];
	return {
		cwd: root,
		hasUI: over.hasUI ?? false,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: over.sessionManager ?? {
			getSessionId: () => SESSION,
		},
		notifications,
	};
}

function answering(
	values: Partial<Record<string, number>> = {},
): (request: JevRequest) => {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	const defaults: Record<string, number> = {
		in_stage_scope: 1,
		forbidden_work: 0,
		scope_drift: 0,
		progress: 1,
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

async function invokeTurnEnd(
	pi: CapturedPi,
	event: any,
	ctx: Ctx,
): Promise<void> {
	for (const handler of pi.handlers.get("turn_end") ?? []) {
		await handler(event, ctx);
	}
}

async function invokeBeforeAgentStart(
	pi: CapturedPi,
	ctx: Ctx,
): Promise<string | undefined> {
	let result: any;
	for (const handler of pi.handlers.get("before_agent_start") ?? []) {
		const next = await handler(
			{ systemPrompt: "BASE", systemPromptOptions: { skills: [] } },
			ctx,
		);
		if (next) result = next;
	}
	return result?.systemPrompt as string | undefined;
}

async function readLog(): Promise<string> {
	try {
		return await fs.readFile(path.join(root, DRIFT_LOG_FILE), "utf8");
	} catch {
		return "";
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "drift-wiring-"));
	setStartupFeaturesForTests(
		testFeatures({
			stageGate: { mode: "off" },
			driftGuard: { mode: "shadow", failClosed: false },
		}),
	);
	setActiveStage(STAGE);
});

afterEach(async () => {
	setStartupFeaturesForTests(null);
	__setDriftJevFactory(null);
	clearActiveStage();
	resetPedstackState();
	await fs.rm(root, { recursive: true, force: true });
});

describe("turn_end wiring", () => {
	test("shadow writes a JSONL line and returns undefined", async () => {
		const pi = makePi();
		__setDriftJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		register(pi);

		const result = await invokeTurnEnd(pi, turnEvent(), makeCtx());
		expect(result).toBeUndefined();

		const lines = (await readLog()).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).verdict).toBe("no_drift");
		expect(JSON.parse(lines[0]).mode).toBe("shadow");
	});

	test("a leaf-only session manager does not crash", async () => {
		const pi = makePi();
		__setDriftJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		register(pi);

		await expect(
			invokeTurnEnd(
				pi,
				turnEvent(),
				makeCtx({ sessionManager: { getLeafId: () => "leaf1" } }),
			),
		).resolves.toBeUndefined();
		expect((await readLog()).trim().split("\n")).toHaveLength(1);
	});

	test("a throwing Jev runtime fails open without throwing", async () => {
		const pi = makePi();
		const throwing: JevRuntime = {
			decide() {
				throw new Error("jev down");
			},
		};
		__setDriftJevFactory(() => throwing);
		register(pi);

		await expect(
			invokeTurnEnd(pi, turnEvent(), makeCtx()),
		).resolves.toBeUndefined();
	});

	test("a malformed message shape is a no-op with no Jev call", async () => {
		const pi = makePi();
		const jev = createFakeJevRuntime({ handler: answering() });
		__setDriftJevFactory(() => jev);
		register(pi);

		const malformed = {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", content: "nope" },
			toolResults: [{ nonsense: true }],
		};
		await expect(
			invokeTurnEnd(pi, malformed, makeCtx()),
		).resolves.toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});
});

describe("one-shot correction", () => {
	test("enforce mild injects exactly once and clears", async () => {
		setStartupFeaturesForTests(
			testFeatures({
				stageGate: { mode: "off" },
				driftGuard: { mode: "enforce", failClosed: false },
			}),
		);
		const pi = makePi();
		__setDriftJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ in_stage_scope: 0.1 }) }),
		);
		register(pi);
		const ctx = makeCtx();

		await invokeTurnEnd(pi, turnEvent(), ctx);
		const first = await invokeBeforeAgentStart(pi, ctx);
		expect(first).toContain(DRIFT_CORRECTION_HEADING);
		expect(first?.match(/Stage Drift Correction/g)).toHaveLength(1);

		const second = await invokeBeforeAgentStart(pi, ctx);
		expect(second).toBeUndefined();
	});

	test("shadow never injects a correction", async () => {
		const pi = makePi();
		__setDriftJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ in_stage_scope: 0.1 }) }),
		);
		register(pi);
		const ctx = makeCtx();
		await invokeTurnEnd(pi, turnEvent(), ctx);
		expect(await invokeBeforeAgentStart(pi, ctx)).toBeUndefined();
	});
});

describe("session lifecycle", () => {
	test("session_shutdown clears in-memory state but leaves records", async () => {
		setStartupFeaturesForTests(
			testFeatures({
				stageGate: { mode: "off" },
				driftGuard: { mode: "enforce", failClosed: false },
			}),
		);
		const pi = makePi();
		__setDriftJevFactory(() =>
			createFakeJevRuntime({ handler: answering({ forbidden_work: 0.9 }) }),
		);
		register(pi);
		const ctx = makeCtx();
		await invokeTurnEnd(pi, turnEvent(), ctx);

		const recordPath = path.join(
			root,
			".context",
			"compound-engineering",
			"drift",
			`${STAGE}.json`,
		);
		expect(existsSync(recordPath)).toBe(true);

		for (const handler of pi.handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown" }, ctx);
		}
		expect(existsSync(recordPath)).toBe(true);
	});

});

describe("handoff tool receives drift options", () => {
	test("an unresolved strong record blocks the registered save", async () => {
		setStartupFeaturesForTests(
			testFeatures({
				stageGate: { mode: "off" },
				driftGuard: { mode: "enforce", failClosed: false },
			}),
		);
		const pi = makePi();
		__setDriftJevFactory(() => createFakeJevRuntime({ handler: answering() }));
		register(pi);
		setCurrentDriftSessionKey(SESSION);
		await writeDriftRecord(root, {
			schema: 1,
			stage: "02-plan",
			sessionKey: SESSION,
			turnIndex: 1,
			signature: "sig",
			thresholdsVersion: THRESHOLDS_VERSION,
			verdict: "strong_drift",
			source: "jev",
			triggered: ["forbidden_work"],
			consecutiveMild: 0,
			consecutiveNoDrift: 0,
			updatedAt: new Date().toISOString(),
		});

		const tool = pi.tools.find((entry) => entry.name === "context_handoff");
		expect(tool).toBeDefined();
		const result = await tool!.execute("call", {
			operation: "save",
			repoRoot: root,
			currentStage: "02-plan",
			nextStage: "03-work",
			contextHealth: "good",
			activeFiles: [],
			artifacts: {},
			currentTruth: ["truth"],
		});
		expect(result.details.blocker).toContain("strong drift");
	});
});
