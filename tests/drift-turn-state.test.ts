// Unit 2 — pure TurnEndEvent → compact drift turn-state builder (AD-1).
import { describe, expect, test } from "bun:test";
import {
	ACTION_REASON_BYTES,
	MAX_ACTIONS,
	MAX_REQUEST_BODY_BYTES,
	buildDriftRequest,
	enforceRequestBodyLimit,
} from "../extensions/ce-core/drift/combine.js";
import { buildTurnState } from "../extensions/ce-core/drift/turn-state.js";
import type { StageDiscipline } from "../extensions/ce-core/utils/stage-policy";

const REPO = "/repo";

const PLAN: StageDiscipline = {
	mandate: "plan",
	forbidden: "no source",
	nextStage: "03-work",
};
const WORK: StageDiscipline = {
	mandate: "implement",
	forbidden: "no scope change",
	nextStage: "04-review",
};

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

function result(
	toolCallId: string,
	toolName: string,
	options: { isError?: boolean; text?: string } = {},
): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: options.text ? [{ type: "text", text: options.text }] : [],
		isError: options.isError ?? false,
		timestamp: 1,
	};
}

describe("buildTurnState", () => {
	test("pairs a write tool call with its result", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([
				{ type: "text", text: "Writing the test." },
				toolCall("c1", "write", { path: "tests/foo.test.ts" }),
			]),
			toolResults: [result("c1", "write")],
		});
		expect(state).not.toBeNull();
		expect(state?.actions).toHaveLength(1);
		expect(state?.actions[0]).toMatchObject({
			tool: "write",
			effect: "tests",
			target: "tests/foo.test.ts",
			error: false,
		});
		expect(state?.wroteStageArtifact).toBe(true);
	});

	test("read-only turn with text is non-trivial", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "04-review",
			discipline: PLAN,
			message: assistant([
				{ type: "text", text: "Reviewing the diff." },
				toolCall("c1", "read", { path: "src/a.ts" }),
			]),
			toolResults: [result("c1", "read")],
		});
		expect(state).not.toBeNull();
		expect(state?.assistantExcerpt).toContain("Reviewing the diff.");
		expect(state?.actions[0]?.effect).toBe("read_only");
	});

	test("returns null when there is neither text nor an action", () => {
		expect(
			buildTurnState({
				repoRoot: REPO,
				stage: "02-plan",
				discipline: PLAN,
				message: assistant([]),
				toolResults: [],
			}),
		).toBeNull();
	});

	test("classifies bash effect and target", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([
				toolCall("c1", "bash", { command: "rm -rf src/old" }),
			]),
			toolResults: [result("c1", "bash")],
		});
		expect(state?.actions[0]?.effect).toBe("deletes_or_destructive");
		expect(state?.actions[0]?.target).toContain("rm -rf");
	});

	test("carries a capped error reason", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([toolCall("c1", "bash", { command: "bun test" })]),
			toolResults: [
				result("c1", "bash", {
					isError: true,
					text: "boom ".repeat(200),
				}),
			],
		});
		const reason = state?.actions[0]?.reason ?? "";
		expect(state?.actions[0]?.error).toBe(true);
		expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(
			ACTION_REASON_BYTES + Buffer.byteLength("…[truncated]"),
		);
	});

	test("wroteStageArtifact is false for a foreign artifact class", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([toolCall("c1", "write", { path: "docs/plans/x.md" })]),
			toolResults: [result("c1", "write")],
		});
		expect(state?.wroteStageArtifact).toBe(false);
	});

	test("wroteStageArtifact false for a read-only turn", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([toolCall("c1", "read", { path: "src/a.ts" })]),
			toolResults: [result("c1", "read")],
		});
		expect(state?.wroteStageArtifact).toBe(false);
	});

	test("caps the action list at MAX_ACTIONS", () => {
		const calls = Array.from({ length: MAX_ACTIONS + 5 }, (_, index) =>
			toolCall(`c${index}`, "read", { path: `src/${index}.ts` }),
		);
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant(calls),
			toolResults: [],
		});
		expect(state?.actions).toHaveLength(MAX_ACTIONS);
	});

	test("does not throw on a malformed message shape", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: { role: "assistant", content: "not-an-array" } as never,
			toolResults: [{ nonsense: true }] as never,
		});
		expect(state).toBeNull();
	});

	test("ignores unknown content blocks without throwing", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "c1" },
			]),
			toolResults: [],
		});
		expect(state).not.toBeNull();
		expect(state?.actions).toHaveLength(1);
	});

	test("redacts secrets in the excerpt and stays under the request cap", () => {
		const state = buildTurnState({
			repoRoot: REPO,
			stage: "03-work",
			discipline: WORK,
			message: assistant([
				{ type: "text", text: "API_TOKEN=supersecret then " + "x".repeat(5000) },
			]),
			toolResults: [],
		});
		expect(state?.assistantExcerpt).not.toContain("supersecret");
		const request = buildDriftRequest(state!);
		enforceRequestBodyLimit(request);
		expect(
			Buffer.byteLength(JSON.stringify(request), "utf8"),
		).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES);
	});
});
