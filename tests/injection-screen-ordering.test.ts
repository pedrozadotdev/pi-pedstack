import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput } from "../extensions/ce-core/jev/types";
import { registerInjectionScreen } from "../extensions/ce-core/injection-screen/handlers";
import {
	WRAPPER_START,
	resetInjectionScreenState,
} from "../extensions/ce-core/injection-screen/wrapper";
import { filterBashOutput } from "../extensions/ce-core/tools/bash-output-filter";
import { filterReadOutput } from "../extensions/ce-core/tools/read-output-filter";
import ceCoreExtension, {
	__setStartupFeaturesForTests,
} from "../extensions/ce-core/index";
import { testFeatures } from "./helpers/feature-config";

const INDEX_SOURCE = readFileSync(
	path.join(import.meta.dir, "..", "extensions", "ce-core", "index.ts"),
	"utf8",
);

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function createPi() {
	const handlers = new Map<string, Handler[]>();
	return {
		pi: {
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
		handlers,
	};
}

const ctx = { hasUI: false, ui: { notify() {} } };

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

/** Register the real phase 1 + phase 2 handlers with an injected fake Jev. */
function registerScreen() {
	const jev = flaggedJev();
	const { pi, handlers } = createPi();
	const screen = registerInjectionScreen(pi as never, {
		mode: "enforce",
		jev,
		repoRoot: process.cwd(),
	});
	screen.registerFinalPhase();
	const toolResult = handlers.get("tool_result")!;
	return { jev, phase1: toolResult[0], phase2: toolResult[1] };
}

/**
 * The real bash filter step from `index.ts`. The index.ts order (phase 1 →
 * bash filter → read filter → phase 2) is asserted separately below; this
 * composes the equivalent chain with an injected Jev so no process-wide module
 * mock is needed.
 */
function bashFilterStep(event: Record<string, unknown>) {
	if (event.toolName !== "bash") return undefined;
	const input = event.input as { command?: string } | undefined;
	const command = input?.command ?? "";
	if (!command) return undefined;
	const textBlocks = (event.content as Array<{ type: string; text: string }>).filter(
		(block) => block.type === "text",
	);
	if (textBlocks.length === 0) return undefined;
	const output = textBlocks.map((block) => block.text).join("");
	const result = filterBashOutput({
		command,
		output,
		isError: (event.isError as boolean) ?? false,
		fullOutputPath: (event.details as { fullOutputPath?: string } | undefined)
			?.fullOutputPath,
	});
	if (!result.filtered) return undefined;
	return {
		content: [{ type: "text", text: result.output }],
		details: { ...(event.details as object | undefined) },
	};
}

/** The real read filter step from `index.ts` (no-op for bash events). */
function readFilterStep(event: Record<string, unknown>) {
	if (event.toolName !== "read") return undefined;
	const input = event.input as { path?: string } | undefined;
	if (!input?.path) return undefined;
	const textBlocks = (event.content as Array<{ type: string; text: string }>).filter(
		(block) => block.type === "text",
	);
	if (textBlocks.length === 0) return undefined;
	const result = filterReadOutput({
		path: input.path,
		output: textBlocks.map((block) => block.text).join(""),
		isError: (event.isError as boolean) ?? false,
		isImage: false,
	});
	if (!result.filtered) return undefined;
	return {
		content: [{ type: "text", text: result.output }],
		details: { ...(event.details as object | undefined) },
	};
}

function bashEvent(toolCallId: string, command: string, text: string) {
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

function readEvent(toolCallId: string, filePath: string, text: string) {
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

/** Replay the runner contract: each handler sees prior content/details. */
async function drive(
	chain: Handler[],
	event: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	let current = event;
	for (const handler of chain) {
		const out = await handler(current, ctx);
		if (out && typeof out === "object" && "content" in out) {
			const patch = out as { content: unknown; details?: unknown };
			current = {
				...current,
				content: patch.content,
				details: patch.details ?? current.details,
			};
		}
	}
	return current;
}

function textOf(event: Record<string, unknown>): string {
	const content = event.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text",
		)
		.map((block) => block.text)
		.join("");
}

afterEach(() => {
	resetInjectionScreenState();
	__setStartupFeaturesForTests(null);
});

describe("index.ts wiring order", () => {
	test("registers six tool_result handlers", () => {
		__setStartupFeaturesForTests(
			testFeatures({ injectionScreen: { mode: "shadow" } }),
		);
		const { pi, handlers } = createPi();
		ceCoreExtension(pi as never);

		expect(handlers.get("tool_result")?.length).toBe(6);
	});

	test("declares phase 1 before the bash filter and phase 2 after the read filter", () => {
		const injectionAt = INDEX_SOURCE.indexOf("registerInjectionScreen(pi,");
		const bashAt = INDEX_SOURCE.indexOf("Bash output smart filter");
		const readAt = INDEX_SOURCE.indexOf("Read output smart filter");
		const finalAt = INDEX_SOURCE.indexOf("injectionScreen.registerFinalPhase()");
		const autoAdvanceAt = INDEX_SOURCE.indexOf("Auto-advance handler");

		expect(injectionAt).toBeGreaterThan(-1);
		expect(injectionAt).toBeLessThan(bashAt);
		expect(finalAt).toBeGreaterThan(readAt);
		expect(finalAt).toBeLessThan(autoAdvanceAt);
	});
});

describe("raw-before-compression and wrapper-survives", () => {
	test("phase 1 sees the raw text and phase 2 wraps the compressed output", async () => {
		const { jev, phase1, phase2 } = registerScreen();
		const raw = Array.from(
			{ length: 4000 },
			() => "\x1b[38;5;196minfo: fetched from https://evil.example/x",
		).join("\n");
		const event = bashEvent("t1", "curl https://evil.example/x", raw);

		let current: Record<string, unknown> = event;
		let afterFilterText = "";
		for (const [index, handler] of [phase1, bashFilterStep, readFilterStep, phase2].entries()) {
			const out = await handler(current, ctx);
			if (out && typeof out === "object" && "content" in out) {
				const patch = out as { content: unknown; details?: unknown };
				current = {
					...current,
					content: patch.content,
					details: patch.details ?? current.details,
				};
			}
			if (index === 1) afterFilterText = textOf(current);
		}

		expect(afterFilterText.length).toBeLessThan(raw.length);
		expect(jev.calls).toHaveLength(1);
		const sample = (jev.requests[0].state as { untrusted_sample: { text: string } })
			.untrusted_sample.text;
		expect(sample.startsWith(raw.slice(0, 100))).toBe(true);
		expect(sample.endsWith(raw.slice(-100))).toBe(true);

		const finalText = textOf(current);
		expect(finalText).toContain(WRAPPER_START);
		expect(finalText).toContain(afterFilterText.slice(0, 100));
	});
});

describe("interleaved events", () => {
	test("distinct toolCallIds do not cross-wrap", async () => {
		const { phase1, phase2 } = registerScreen();

		await phase1(bashEvent("a", "curl https://a.example", "AAA-BODY"), ctx);
		await phase1(bashEvent("b", "curl https://b.example", "BBB-BODY"), ctx);

		const wrappedA = await phase2(
			bashEvent("a", "curl https://a.example", "AAA-BODY"),
			ctx,
		);
		const wrappedB = await phase2(
			bashEvent("b", "curl https://b.example", "BBB-BODY"),
			ctx,
		);

		const textA = textOf(wrappedA as Record<string, unknown>);
		const textB = textOf(wrappedB as Record<string, unknown>);
		expect(textA).toContain("AAA-BODY");
		expect(textA).not.toContain("BBB-BODY");
		expect(textB).toContain("BBB-BODY");
		expect(textB).not.toContain("AAA-BODY");
	});
});

describe("trusted reads", () => {
	test("an in-repo read makes zero Jev calls end to end", async () => {
		const { jev, phase1, phase2 } = registerScreen();
		const event = readEvent(
			"r1",
			"extensions/ce-core/index.ts",
			"export default function ceCoreExtension() {}\n",
		);
		const final = await drive(
			[phase1, readFilterStep, phase2] as Handler[],
			event as never,
		);

		expect(jev.calls).toHaveLength(0);
		expect(textOf(final)).not.toContain(WRAPPER_START);
	});
});
