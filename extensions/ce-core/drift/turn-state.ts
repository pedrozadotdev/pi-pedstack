// Pure `TurnEndEvent` → compact drift turn-state builder (AD-1). Derives every
// fact from the single turn event; every field access is runtime-shape-guarded
// so an unexpected Pi shape yields `null`/`[]`, never a throw.
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { classifyPath } from "../utils/capability-matrix";
import { classifyCommandEffect } from "../utils/command-effect";
import type { StageDiscipline } from "../utils/stage-policy";
import {
	ACTION_REASON_BYTES,
	ACTION_TARGET_BYTES,
	EXCERPT_BYTES,
	MAX_ACTIONS,
	redactSecrets,
	truncateToBytes,
} from "./combine";
import type { DriftTurnAction, DriftTurnState } from "./types";

export interface BuildTurnStateInput {
	repoRoot: string;
	stage: string;
	discipline: StageDiscipline;
	message: TurnEndEvent["message"];
	toolResults: TurnEndEvent["toolResults"];
}

/** A non-trivial turn writes the stage's own artifact class (AD-6 mapping). */
const STAGE_ARTIFACT_CLASSES: Record<string, readonly string[]> = {
	"01-brainstorm": ["brainstorm"],
	"02-plan": ["plan"],
	"03-work": ["source", "tests", "config"],
	"04-review": ["review"],
	"04-5-debug": ["source", "tests"],
	"05-learn": ["solution"],
	"06-docsync": ["docs"],
};

interface ToolCallFact {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

interface ToolResultFact {
	isError: boolean;
	reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** Concatenate `text` blocks of an assistant message, redacted and byte-capped. */
function extractExcerpt(message: unknown): string {
	const record = asRecord(message);
	if (!record || record.role !== "assistant") return "";
	if (!Array.isArray(record.content)) return "";

	let text = "";
	for (const block of record.content) {
		const entry = asRecord(block);
		if (entry && entry.type === "text" && typeof entry.text === "string") {
			text += `${entry.text}\n`;
		}
	}
	return truncateToBytes(redactSecrets(text.trim()), EXCERPT_BYTES);
}

/** Extract `toolCall` blocks; the name defaults to `unknown` when absent. */
function extractCalls(message: unknown): ToolCallFact[] {
	const record = asRecord(message);
	if (!record || !Array.isArray(record.content)) return [];

	const calls: ToolCallFact[] = [];
	for (const block of record.content) {
		const entry = asRecord(block);
		if (!entry || entry.type !== "toolCall") continue;
		calls.push({
			id: typeof entry.id === "string" ? entry.id : "",
			name: typeof entry.name === "string" ? entry.name : "unknown",
			args: asRecord(entry.arguments) ?? {},
		});
	}
	return calls;
}

/** Pair results by `toolCallId`; text is redacted and reason-capped. */
function extractResults(toolResults: unknown): Map<string, ToolResultFact> {
	const map = new Map<string, ToolResultFact>();
	if (!Array.isArray(toolResults)) return map;

	for (const item of toolResults) {
		const record = asRecord(item);
		if (!record || typeof record.toolCallId !== "string") continue;
		let text = "";
		if (Array.isArray(record.content)) {
			for (const block of record.content) {
				const entry = asRecord(block);
				if (entry && entry.type === "text" && typeof entry.text === "string") {
					text += `${entry.text}\n`;
				}
			}
		}
		map.set(record.toolCallId, {
			isError: record.isError === true,
			reason: truncateToBytes(
				redactSecrets(text.trim()),
				ACTION_REASON_BYTES,
			),
		});
	}
	return map;
}

function buildAction(
	repoRoot: string,
	call: ToolCallFact,
	result: ToolResultFact | undefined,
): DriftTurnAction {
	const path = typeof call.args.path === "string" ? call.args.path : "";
	const command =
		typeof call.args.command === "string" ? call.args.command : "";

	let effect = "read_only";
	let target = path;
	if (call.name === "write" || call.name === "edit") {
		target = path;
		effect = classifyPath(repoRoot, path);
	} else if (call.name === "bash") {
		target = command;
		effect = classifyCommandEffect(command).effect;
	}

	const error = result?.isError === true;
	const reason = error && result?.reason ? result.reason : undefined;
	const blocked =
		reason !== undefined && /stage guard blocked/i.test(reason)
			? true
			: undefined;

	return {
		tool: call.name,
		effect,
		target: truncateToBytes(redactSecrets(target), ACTION_TARGET_BYTES),
		error,
		...(blocked ? { blocked: true } : {}),
		...(reason ? { reason } : {}),
	};
}

function didWriteStageArtifact(
	stage: string,
	actions: DriftTurnAction[],
): boolean {
	const classes = STAGE_ARTIFACT_CLASSES[stage];
	if (!classes || classes.length === 0) return false;
	const artifactClasses = new Set(classes);
	for (const action of actions) {
		if (action.error) continue;
		if (action.tool !== "write" && action.tool !== "edit") continue;
		if (artifactClasses.has(action.effect)) return true;
	}
	return false;
}

/**
 * Build the compact turn state, or `null` for a trivial turn (no assistant text
 * and no tool actions). Never throws on an unexpected event shape.
 */
export function buildTurnState(
	input: BuildTurnStateInput,
): DriftTurnState | null {
	try {
		const assistantExcerpt = extractExcerpt(input.message);
		const calls = extractCalls(input.message);
		const results = extractResults(input.toolResults);

		const actions = calls
			.slice(0, MAX_ACTIONS)
			.map((call) => buildAction(input.repoRoot, call, results.get(call.id)));

		if (assistantExcerpt.length === 0 && actions.length === 0) return null;

		return {
			stage: input.stage,
			mandate: input.discipline.mandate,
			forbidden: input.discipline.forbidden,
			actions,
			assistantExcerpt,
			wroteStageArtifact: didWriteStageArtifact(input.stage, actions),
		};
	} catch {
		return null;
	}
}
