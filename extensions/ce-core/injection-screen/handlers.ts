/**
 * Two-phase `tool_result` wiring for the injection screen.
 *
 * Phase 1 runs before the existing bash/read size filters and screens the raw
 * text (best signal); phase 2 runs after them and wraps the final
 * post-compression content when enforce+flagged. All callbacks are additive and
 * never throw.
 *
 * Registration is split so the caller (index.ts) can sandwich the existing
 * filters between the two phases: `registerInjectionScreen(pi)` registers
 * phase 1, and the returned `registerFinalPhase()` registers phase 2 plus the
 * `turn_end` sweep and `session_shutdown` cleanup.
 *
 * @module injection-screen/handlers
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	createInjectionScreenEngine,
	type InjectionScreenEngine,
} from "./engine";
import type { ScreenMode } from "./provenance";
import {
	resetInjectionScreenState,
	wrapTracker,
	wrapUntrusted,
} from "./wrapper";

const NOTIFY_MESSAGES = {
	degraded:
		"Injection screen degraded (Jev unavailable). Unverified content passed through unwrapped.",
	wrapMiss:
		"Injection screen could not wrap a flagged result before it was delivered.",
};

export interface InjectionScreenDeps {
	mode: ScreenMode;
	jev?: JevRuntime;
	jevFactory?: () => JevRuntime;
	now?: () => Date;
	appendLog?: (line: string) => void | Promise<void>;
	repoRoot?: string;
}

export interface InjectionScreenHandle {
	/** Registers phase 2 + lifecycle handlers (call after the read filter). */
	registerFinalPhase(): void;
	engine: InjectionScreenEngine;
}

/** Replacement returned by phase 2 (a subset of `ToolResultEventResult`). */
interface ToolResultPatch {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/** Shared per-registration state passed to the module-level handler bodies. */
interface Runtime {
	engine: InjectionScreenEngine;
	mode: ScreenMode;
	repoRoot: string;
	notifyOnce(ctx: ExtensionContext | undefined, key: string, message: string): void;
}

function readToolCallId(event: unknown): string | undefined {
	const id = (event as { toolCallId?: unknown } | null)?.toolCallId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isScreenableTool(toolName: unknown): toolName is "bash" | "read" {
	return toolName === "bash" || toolName === "read";
}

function readObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") {
			out += typed.text;
		}
	}
	return out;
}

async function resolveRealPath(
	repoRoot: string,
	rawPath: unknown,
): Promise<string | undefined> {
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	const lexical = path.resolve(repoRoot, rawPath);
	try {
		return await fs.realpath(lexical);
	} catch {
		return lexical;
	}
}

function copyDetails(event: unknown): Record<string, unknown> {
	const details = (event as { details?: unknown } | null)?.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return {};
	}
	return { ...(details as Record<string, unknown>) };
}

/** Phase 1: screen the raw result before the bash/read filters compress it. */
async function screenRawPhase(
	rt: Runtime,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): Promise<void> {
	try {
		const toolName = (event as { toolName?: unknown }).toolName;
		if (!isScreenableTool(toolName)) return;
		const toolCallId = readToolCallId(event);
		if (!toolCallId) return;
		const rawText = extractText((event as { content?: unknown }).content);
		if (!rawText) return;

		const input = readObject((event as { input?: unknown }).input);
		const realPath =
			toolName === "read"
				? await resolveRealPath(rt.repoRoot, input.path)
				: undefined;
		const verdict = await rt.engine.screen({
			toolCallId,
			toolName,
			input,
			rawText,
			realPath,
		});
		if (verdict === "degraded" && rt.mode === "enforce") {
			rt.notifyOnce(ctx, "degraded", NOTIFY_MESSAGES.degraded);
		}
	} catch {
		// ponytail: additive handler — a bug here must never break a tool result.
	}
}

/** Phase 2: wrap the final post-compression content when enforce+flagged. */
async function wrapFinalPhase(
	rt: Runtime,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): Promise<ToolResultPatch | void> {
	try {
		const toolName = (event as { toolName?: unknown }).toolName;
		if (!isScreenableTool(toolName)) return;
		const toolCallId = readToolCallId(event);
		if (!toolCallId) return;
		const stored = rt.engine.consume(toolCallId);
		if (!stored || stored.mode !== "enforce" || stored.verdict !== "flagged") {
			return;
		}
		if (wrapTracker.has(toolCallId)) return;

		const finalText = extractText((event as { content?: unknown }).content);
		if (!finalText) {
			await rt.engine.recordWrapMiss(toolCallId, stored);
			rt.notifyOnce(ctx, "wrapMiss", NOTIFY_MESSAGES.wrapMiss);
			return;
		}

		wrapTracker.mark(toolCallId);
		return {
			content: [
				{
					type: "text",
					text: wrapUntrusted(finalText, stored.provenance),
				},
			],
			details: copyDetails(event),
		};
	} catch {
		return;
	}
}

/** A leftover verdict at turn end means phase 2 never saw it: wrap-miss. */
async function sweepAtTurnEnd(
	rt: Runtime,
	_ctx: ExtensionContext,
): Promise<void> {
	try {
		const swept = await rt.engine.sweepTurn();
		if (swept.notify) rt.notifyOnce(_ctx, "wrapMiss", NOTIFY_MESSAGES.wrapMiss);
	} catch {
		// ponytail: lifecycle cleanup is best-effort.
	}
}

function clearAtShutdown(rt: Runtime): void {
	try {
		rt.engine.clear();
		resetInjectionScreenState();
	} catch {
		// ponytail: shutdown cleanup is best-effort.
	}
}

export function registerInjectionScreen(
	pi: ExtensionAPI,
	deps: InjectionScreenDeps,
): InjectionScreenHandle {
	const mode = deps.mode;
	const repoRoot = deps.repoRoot ?? process.cwd();

	let lazyJev: JevRuntime | null = null;
	const jev: JevRuntime =
		deps.jev ??
		({
			decide(request, options) {
				if (!lazyJev) {
					lazyJev = deps.jevFactory ? deps.jevFactory() : createJevRuntime();
				}
				return lazyJev.decide(request, options);
			},
		} satisfies JevRuntime);

	const engine = createInjectionScreenEngine({
		jev,
		repoRoot,
		mode,
		now: deps.now,
		appendLog: deps.appendLog,
	});

	const notified = new Set<string>();
	const rt: Runtime = {
		engine,
		mode,
		repoRoot,
		notifyOnce(ctx, key, message) {
			try {
				if (!ctx?.hasUI || notified.has(key)) return;
				notified.add(key);
				ctx.ui.notify(message, "warning");
			} catch {
				// ponytail: a notify failure must never affect the tool result.
			}
		},
	};

	pi.on(
		"tool_result",
		((event, ctx) => screenRawPhase(rt, event, ctx)) satisfies ExtensionHandler<ToolResultEvent>,
	);

	return {
		engine,
		registerFinalPhase(): void {
			pi.on(
				"tool_result",
				((event, ctx) =>
					wrapFinalPhase(rt, event, ctx)) satisfies ExtensionHandler<
					ToolResultEvent,
					ToolResultPatch
				>,
			);
			pi.on(
				"turn_end",
				((_event, ctx) =>
					sweepAtTurnEnd(rt, ctx)) satisfies ExtensionHandler<TurnEndEvent>,
			);
			pi.on(
				"session_shutdown",
				(() => clearAtShutdown(rt)) satisfies ExtensionHandler<SessionShutdownEvent>,
			);
		},
	};
}
