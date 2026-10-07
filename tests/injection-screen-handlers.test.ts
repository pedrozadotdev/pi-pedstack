import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput } from "../extensions/ce-core/jev/types";
import { registerInjectionScreen } from "../extensions/ce-core/injection-screen/handlers";
import {
	WRAPPER_START,
	resetInjectionScreenState,
} from "../extensions/ce-core/injection-screen/wrapper";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-inj-handlers-"));
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
	tempRoots.push(root);
	return root;
}

function jevOutput(answers: Record<string, unknown>): JevProcessOutput {
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "fake-jev" }),
		stderr: "",
	};
}

function flaggedJev() {
	return createFakeJevRuntime({
		handler: () =>
			jevOutput({
				agent_directed_instruction: {
					type: "noul",
					noul: 0.9,
					confidence: 0.9,
				},
			}),
	});
}

function createPi() {
	const handlers = new Map<string, unknown[]>();
	return {
		pi: {
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
		handlers,
	};
}

function createCtx(hasUI = false) {
	const notifyCalls: { message: string; level: string }[] = [];
	return {
		ctx: {
			hasUI,
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		},
		notifyCalls,
	};
}

function bashEvent(toolCallId: string, command: string, text = "curl body") {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		input: { command },
		content: [{ type: "text", text }],
		isError: false,
		details: {},
	};
}

function readEvent(toolCallId: string, filePath: string, text = "file body") {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId,
		input: { path: filePath },
		content: [{ type: "text", text }],
		isError: false,
		details: {},
	};
}

function register(
	pi: unknown,
	jev: unknown,
	repoRoot: string,
	appendLog?: (l: string) => void,
	mode: "off" | "shadow" | "enforce" = "shadow",
) {
	return registerInjectionScreen(pi as never, {
		mode,
		jev: jev as never,
		repoRoot,
		appendLog,
	});
}

afterEach(() => {
	resetInjectionScreenState();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("registerInjectionScreen — registration", () => {
	test("registers phase-1, phase-2, turn_end, and session_shutdown handlers", () => {
		const { pi, handlers } = createPi();
		const handle = register(pi, flaggedJev(), makeRepo());
		handle.registerFinalPhase();

		expect(handlers.get("tool_result")?.length).toBe(2);
		expect(handlers.get("turn_end")?.length).toBe(1);
		expect(handlers.get("session_shutdown")?.length).toBe(1);
	});

	test("phase 1 is registered first and phase 2 only on finalize", () => {
		const { pi, handlers } = createPi();
		const handle = register(pi, flaggedJev(), makeRepo());

		expect(handlers.get("tool_result")?.length).toBe(1);
		handle.registerFinalPhase();
		expect(handlers.get("tool_result")?.length).toBe(2);
	});
});

describe("phase 1", () => {
	test("a trusted read calls no Jev and returns undefined", async () => {
		const repo = makeRepo();
		const jev = flaggedJev();
		const { pi, handlers } = createPi();
		register(pi, jev, repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const { ctx } = createCtx();

		const result = await (phase1 as Function)(readEvent("t1", "src/a.ts"), ctx);

		expect(result).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});

	test("a curl bash result is screened but never modifies content", async () => {
		const repo = makeRepo();
		const jev = flaggedJev();
		const { pi, handlers } = createPi();
		const handle = register(pi, jev, repo);
		handle.registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const { ctx } = createCtx();

		const result = await (phase1 as Function)(
			bashEvent("t1", "curl https://example.com", "raw curl body"),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(jev.calls).toHaveLength(1);
		expect(handle.engine.consume("t1")?.verdict).toBe("flagged");
	});

	test("ignores non bash/read tools and malformed events without throwing", async () => {
		const repo = makeRepo();
		const jev = flaggedJev();
		const { pi, handlers } = createPi();
		register(pi, jev, repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const { ctx } = createCtx();

		expect(
			await (phase1 as Function)(
				{ type: "tool_result", toolName: "edit", input: {}, content: [] },
				ctx,
			),
		).toBeUndefined();
		expect(
			await (phase1 as Function)(
				{ type: "tool_result", toolName: "bash", input: {}, content: null },
				ctx,
			),
		).toBeUndefined();
		expect(
			await (phase1 as Function)(
				{ type: "tool_result", toolName: "bash", content: "not-an-array" },
				ctx,
			),
		).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});
});

describe("phase 2", () => {
	test("enforce + flagged wraps the final content with identical inner bytes", async () => {
				const repo = makeRepo();
		const { pi, handlers } = createPi();
		register(pi, flaggedJev(), repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const { ctx } = createCtx();
		const event = bashEvent("t1", "curl https://example.com", "FINAL TEXT");

		await (phase1 as Function)(event, ctx);
		const result = await (phase2 as Function)(event, ctx);

		const text = (result as { content: { text: string }[] }).content[0].text;
		expect(text).toContain(WRAPPER_START);
		const inner = text.slice(
			text.indexOf(WRAPPER_START) + WRAPPER_START.length + 1,
			text.lastIndexOf("--- END UNTRUSTED CONTENT ---") - 1,
		);
		expect(inner).toBe("FINAL TEXT");
	});

	test("does not double-wrap the same toolCallId", async () => {
				const repo = makeRepo();
		const { pi, handlers } = createPi();
		register(pi, flaggedJev(), repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const { ctx } = createCtx();
		const event = bashEvent("t1", "curl https://example.com");

		await (phase1 as Function)(event, ctx);
		const first = await (phase2 as Function)(event, ctx);
		expect(first).toBeDefined();

		await (phase1 as Function)(event, ctx);
		const second = await (phase2 as Function)(event, ctx);
		expect(second).toBeUndefined();
	});

	test("shadow mode leaves content unchanged", async () => {
		const repo = makeRepo();
		const { pi, handlers } = createPi();
		register(pi, flaggedJev(), repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const { ctx } = createCtx();

		await (phase1 as Function)(bashEvent("t1", "curl https://example.com"), ctx);
		const result = await (phase2 as Function)(
			bashEvent("t1", "curl https://example.com"),
			ctx,
		);

		expect(result).toBeUndefined();
	});

	test("a flagged+enforce result with no text records a wrap-miss and does not throw", async () => {
				const repo = makeRepo();
		const logs: string[] = [];
		const { pi, handlers } = createPi();
		register(pi, flaggedJev(), repo, (l) => logs.push(l), "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const { ctx } = createCtx();

		await (phase1 as Function)(bashEvent("t1", "curl https://example.com"), ctx);
		const result = await (phase2 as Function)(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "t1",
				input: { command: "curl https://example.com" },
				content: [],
				isError: false,
			},
			ctx,
		);

		expect(result).toBeUndefined();
		expect(logs.some((l) => l.includes('"wrapMiss":true'))).toBe(true);
	});
});

describe("degraded and lifecycle", () => {
	test("enforce + degraded notifies once and never changes content", async () => {
				const repo = makeRepo();
		const jev = createFakeJevRuntime({ handler: () => new Error("jev down") });
		const { pi, handlers } = createPi();
		register(pi, jev, repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const { ctx, notifyCalls } = createCtx(true);
		const event = bashEvent("t1", "curl https://example.com");

		const first = await (phase1 as Function)(event, ctx);
		const second = await (phase1 as Function)(event, ctx);
		const wrapped = await (phase2 as Function)(event, ctx);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(wrapped).toBeUndefined();
		expect(notifyCalls).toHaveLength(1);
	});

	test("session_shutdown clears the verdict map and the wrap tracker", async () => {
				const repo = makeRepo();
		const { pi, handlers } = createPi();
		const handle = register(pi, flaggedJev(), repo, undefined, "enforce");
		handle.registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const phase2 = handlers.get("tool_result")![1] as never;
		const shutdown = handlers.get("session_shutdown")![0] as never;
		const { ctx } = createCtx();
		const event = bashEvent("t1", "curl https://example.com");

		await (phase1 as Function)(event, ctx);
		await (phase2 as Function)(event, ctx);
		await (shutdown as Function)({ type: "session_shutdown" }, ctx);

		expect(handle.engine.consume("t1")).toBeUndefined();
		expect(handle.engine.stats()).toEqual({
			clean: 0,
			flagged: 0,
			degraded: 0,
			wrapMiss: 0,
		});
	});

	test("turn_end sweeps leftovers and reports a notify without throwing", async () => {
				const repo = makeRepo();
		const { pi, handlers } = createPi();
		register(pi, flaggedJev(), repo, undefined, "enforce").registerFinalPhase();
		const phase1 = handlers.get("tool_result")![0] as never;
		const turnEnd = handlers.get("turn_end")![0] as never;
		const { ctx, notifyCalls } = createCtx(true);

		await (phase1 as Function)(bashEvent("t1", "curl https://example.com"), ctx);
		const result = await (turnEnd as Function)(
			{ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] },
			ctx,
		);

		expect(result).toBeUndefined();
		expect(notifyCalls).toHaveLength(1);
	});

});
