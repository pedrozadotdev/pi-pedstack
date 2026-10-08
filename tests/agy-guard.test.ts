import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countAgyJudgments, createAgyRequest, recordAgyHookEvent, recordAgyToolDecision, verifyAgyChallenge, verifyAgyLifecycle, type AgyHookEvent, type AgyRequest } from "../extensions/ce-core/review/agy-state";
import { handleAgyHook } from "../extensions/ce-core/review/agy-guard";
import * as jev from "../extensions/ce-core/jev/runtime";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
function request(challenge = false, realWorkspace = false) {
	root = mkdtempSync(path.join(tmpdir(), "agy-state-test-"));
	return createAgyRequest(root, { stage: "04-review", model: "gemini-test", workspace: realWorkspace ? root : "/repo", task: "inspect changes", challenge });
}
const base = { conversationId: "conversation-a", modelName: "gemini-test", workspacePaths: ["/repo"] };

async function invokeHook(req: AgyRequest, eventName: string, input: Omit<AgyHookEvent, "event">, token = req.id): Promise<Record<string, unknown>> {
	let stdout = "";
	const writer = spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += chunk.toString(); return true; });
	try {
		await handleAgyHook(JSON.stringify(input), { PEDSTACK_AGY_REQUEST: req.requestPath, PEDSTACK_AGY_TOKEN: token, PEDSTACK_AGY_JEV_COMMAND: "/trusted/bin/cmd" }, eventName);
		return JSON.parse(stdout) as Record<string, unknown>;
	} finally { writer.mockRestore(); }
}

async function invokeHooksConcurrently(req: AgyRequest, inputs: Array<Omit<AgyHookEvent, "event">>): Promise<Record<string, unknown>[]> {
	const outputs: string[] = [];
	const writer = spyOn(process.stdout, "write").mockImplementation((chunk) => { outputs.push(chunk.toString()); return true; });
	try {
		await Promise.all(inputs.map((input) => handleAgyHook(JSON.stringify(input), {
			PEDSTACK_AGY_REQUEST: req.requestPath,
			PEDSTACK_AGY_TOKEN: req.id,
			PEDSTACK_AGY_JEV_COMMAND: "/trusted/bin/cmd",
		}, "PreToolUse")));
		return outputs.map((output) => JSON.parse(output) as Record<string, unknown>);
	} finally { writer.mockRestore(); }
}

async function invokeBundledHook(raw: Buffer, req: AgyRequest, splitAt?: number): Promise<Record<string, unknown>> {
	const guardPath = path.resolve(import.meta.dir, "../plugins/agy-reviewer/guard.js");
	const env: NodeJS.ProcessEnv = { ...process.env, PEDSTACK_AGY_REQUEST: req.requestPath, PEDSTACK_AGY_TOKEN: req.id };
	delete env.PEDSTACK_AGY_JEV_COMMAND;
	const child = Bun.spawn([process.execPath, guardPath, "PreToolUse"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		if (splitAt === undefined) child.stdin.write(raw);
		else {
			child.stdin.write(raw.subarray(0, splitAt));
			await child.stdin.flush();
			await new Promise((resolve) => setTimeout(resolve, 250));
			child.stdin.write(raw.subarray(splitAt));
		}
		await child.stdin.end();
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (code !== 0) throw new Error(`bundled guard exited ${code}: ${stderr}`);
		return JSON.parse(stdout) as Record<string, unknown>;
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
	}
}

describe("agy request lifecycle", () => {
	test("leaves unmarked agy hooks inert without output or state writes", async () => {
		const req = request();
		const writer = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await handleAgyHook(JSON.stringify(base), {}, "PreToolUse");
			expect(writer).not.toHaveBeenCalled();
			expect(readFileSync(path.join(req.directory, "events.jsonl"), "utf8")).toBe("");
		} finally { writer.mockRestore(); }
	});

	test.each(["not JSON", "[]", "x".repeat(16 * 1024 + 1)])("denies malformed or oversized marked tool input before recording it", async (raw) => {
		const req = request();
		let stdout = "";
		const writer = spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += chunk.toString(); return true; });
		try {
			await handleAgyHook(raw, { PEDSTACK_AGY_REQUEST: req.requestPath, PEDSTACK_AGY_TOKEN: req.id }, "PreToolUse");
			expect(JSON.parse(stdout).decision).toBe("deny");
			expect(readFileSync(path.join(req.directory, "events.jsonl"), "utf8")).toBe("");
			expect(verifyAgyLifecycle(req).healthy).toBe(false);
		} finally { writer.mockRestore(); }
	});

	test("preserves complete UTF-8 hook input across stdin chunks and rejects malformed bytes", async () => {
		root = mkdtempSync(path.join(tmpdir(), "agy-stdin-test-"));
		const workspace = path.join(root, "workspace");
		const stateRoot = path.join(root, "state");
		const outside = path.join(root, "outside.ts");
		mkdirSync(workspace);
		mkdirSync(stateRoot);
		writeFileSync(outside, "outside fixture\n");
		const symlinkPath = path.join(workspace, "café.ts");
		symlinkSync(outside, symlinkPath);
		writeFileSync(path.join(workspace, "caf\uFFFD\uFFFD.ts"), "inside fixture\n");
		const hookInput = Buffer.from(JSON.stringify({
			conversationId: "utf8-conversation",
			modelName: "gemini-test",
			workspacePaths: [realpathSync(workspace)],
			stepIdx: 1,
			toolCall: { name: "view_file", args: { AbsolutePath: symlinkPath } },
		}), "utf8");
		const splitAt = hookInput.indexOf(Buffer.from("é")) + 1;
		expect(splitAt).toBeGreaterThan(0);
		const makeRequest = (): AgyRequest => {
			const req = createAgyRequest(stateRoot, { stage: "04-review", model: "gemini-test", workspace: realpathSync(workspace), task: "inspect changes" });
			expect(recordAgyHookEvent(req, { event: "PreInvocation", conversationId: "utf8-conversation", modelName: "gemini-test", workspacePaths: [realpathSync(workspace)] })).toBe(true);
			return req;
		};
		const expected = { decision: "deny", reason: "path is outside the allowed workspace or enters a denied path" };
		const unsplit = await invokeBundledHook(hookInput, makeRequest());
		const split = await invokeBundledHook(hookInput, makeRequest(), splitAt);
		expect(unsplit).toMatchObject(expected);
		expect(split).toMatchObject(expected);

		const malformed = Buffer.from(hookInput);
		malformed[splitAt] = 0xff;
		const invalid = await invokeBundledHook(malformed, makeRequest());
		expect(invalid).toMatchObject({ decision: "deny", reason: "pi-pedstack guard input is not valid UTF-8" });
	});

	test("denies challenge inspection without a semantic judgment and emits a healthy Stop decision", async () => {
		const req = request(true);
		const fixture = "/tmp/harmless-fixture.txt";
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect((await invokeHook(req, "PreToolUse", { ...base, stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: fixture } } })).decision).toBe("deny");
		expect(countAgyJudgments(req)).toBe(0);
		expect((await invokeHook(req, "Stop", { ...base, terminationReason: "model_stop", fullyIdle: true })).decision).toBe("stop");
		expect(verifyAgyChallenge(req, base.conversationId, fixture)).toBe(true);
	});

	test.each([".npmrc", ".envrc", "id_ecdsa", "secrets.yaml", ".config/gh/hosts.yml"])("denies credential path %s for direct and recursive reads without consulting JEV", async (name) => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const credential = path.join(root, name);
		mkdirSync(path.dirname(credential), { recursive: true });
		writeFileSync(credential, "dummy fixture credential\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => ({ answers: { relevant: { type: "noul", noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] }) });
		try {
			const calls = [
				{ name: "view_file", args: { AbsolutePath: credential } },
				{ name: "grep_search", args: { SearchPath: root, Query: "dummy" } },
				{ name: "find_by_name", args: { SearchDirectory: root, Pattern: "*" } },
			];
			for (const [index, toolCall] of calls.entries()) {
				expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: index + 1, toolCall })).decision).toBe("deny");
			}
			expect(runtime).not.toHaveBeenCalled();
			expect(countAgyJudgments(req)).toBe(0);
		} finally { runtime.mockRestore(); }
	});

	test("denies flat-wide recursive searches before relevance judgment", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const wide = path.join(root, "wide");
		mkdirSync(wide);
		for (let index = 0; index < 1200; index += 1) writeFileSync(path.join(wide, `file-${index}.ts`), "");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => ({ answers: { relevant: { type: "noul", noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] }) });
		try {
			const calls = [
				{ name: "grep_search", args: { SearchPath: wide, Query: "fixture" } },
				{ name: "find_by_name", args: { SearchDirectory: wide, Pattern: "*" } },
			];
			for (const [index, toolCall] of calls.entries()) {
				expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: index + 1, toolCall })).decision).toBe("deny");
			}
			expect(runtime).not.toHaveBeenCalled();
			expect(countAgyJudgments(req)).toBe(0);
		} finally { runtime.mockRestore(); }
	});

	test("atomically caps concurrent relevance judgments at 64", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const value = 1;\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		let judgments = 0;
		let releaseGate = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => {
			judgments += 1;
			await gate;
			return { answers: { relevant: { type: "noul" as const, noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] };
		} });
		const inputs = Array.from({ length: 65 }, (_, index) => ({
			...common,
			stepIdx: index + 1,
			toolCall: { name: "view_file", args: { AbsolutePath: source } },
		}));
		const pending = invokeHooksConcurrently(req, inputs);
		try {
			expect(judgments).toBe(64);
			expect(runtime).toHaveBeenCalledTimes(64);
			releaseGate();
			const results = await pending;
			expect(results.filter((result) => result.decision === "allow")).toHaveLength(64);
			expect(results.filter((result) => result.decision === "deny" && result.reason === "review judgment budget exhausted")).toHaveLength(1);
			const events = readFileSync(path.join(req.directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.filter((event) => event.event === "AgyDecision" && event.degraded === true && event.judged === false)).toHaveLength(1);
			expect(countAgyJudgments(req)).toBe(64);
		} finally {
			releaseGate();
			await pending;
			runtime.mockRestore();
		}
	});

	test("uses the preflighted absolute JEV executable for relevance judgments", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const value = 1;\\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => ({ answers: { relevant: { type: "noul" as const, noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] }) });
		try {
			const result = await invokeHook(req, "PreToolUse", { ...common, stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: source } } });
			expect(result.decision).toBe("allow");
			expect(runtime).toHaveBeenCalledWith({ command: "/trusted/bin/cmd", timeoutMs: 8000 });
		} finally { runtime.mockRestore(); }
	});

	test("rejects an unbound tool call before classification or judgment", async () => {
		const req = request();
		expect((await invokeHook(req, "PreToolUse", { ...base, modelName: "wrong-model", stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } } })).decision).toBe("deny");
		expect(countAgyJudgments(req)).toBe(0);
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
	});

	test("accounts for an allowed tool through hook dispatch before a healthy Stop", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const value = 1;\\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => ({ answers: { relevant: { type: "noul", noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] }) });
		try {
			const toolCall = { name: "view_file", args: { AbsolutePath: source } };
			expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: 1, toolCall })).decision).toBe("allow");
			expect(await invokeHook(req, "PostToolUse", { ...common, stepIdx: 1 })).toEqual({});
			expect(await invokeHook(req, "Stop", { ...common, terminationReason: "model_stop", fullyIdle: true })).toEqual({ decision: "stop" });
			expect(verifyAgyLifecycle(req).healthy).toBe(true);
		} finally { runtime.mockRestore(); }
	});

	test("emits the required native Stop decision for a healthy lifecycle", async () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(await invokeHook(req, "Stop", { ...base, terminationReason: "model_stop", fullyIdle: true })).toEqual({ decision: "stop" });
		expect(verifyAgyLifecycle(req).healthy).toBe(true);
	});

	test("emits a required continuation decision even for a malformed marked Stop", async () => {
		const req = request();
		expect(await invokeHook(req, "Stop", base, "incorrect-token")).toMatchObject({ decision: "continue" });
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
	});

	test("continues a non-final Stop without committing it, then accepts a healthy final Stop", async () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "PreToolUse", ...base, stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } } })).toBe(true);
		recordAgyToolDecision(req, 1, true, false);
		const continued = await invokeHook(req, "Stop", { ...base, terminationReason: "max_steps_exceeded", fullyIdle: false });
		expect(continued.decision).toBe("continue");
		expect(typeof continued.reason).toBe("string");
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
		expect(verifyAgyLifecycle(req).events.filter((event) => (event as { event: string }).event === "Stop")).toHaveLength(0);
		expect(recordAgyHookEvent(req, { event: "PostToolUse", ...base, stepIdx: 1 })).toBe(true);
		const final = await invokeHook(req, "Stop", { ...base, terminationReason: "model_stop", fullyIdle: true });
		expect(final.decision).toBe("stop");
		expect(verifyAgyLifecycle(req).healthy).toBe(true);
		expect(verifyAgyLifecycle(req).events.filter((event) => (event as { event: string }).event === "Stop")).toHaveLength(1);
	});
	test("refuses an append that would exceed the 1 MiB event log bound and permanently prevents success", () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		const log = path.join(req.directory, "events.jsonl");
		const prefix = JSON.stringify({ event: "PreInvocation", conversationId: base.conversationId, padding: "" });
		writeFileSync(log, `${prefix.slice(0, -2)}${"x".repeat(1024 * 1024 - Buffer.byteLength(prefix) - 1)}"}\n`);
		const before = statSync(log).size;
		expect(before).toBe(1024 * 1024);
		expect(() => recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toThrow("bound");
		expect(statSync(log).size).toBe(before);
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
		// The terminal marker survives even if a valid, small log is restored later.
		writeFileSync(log, `${JSON.stringify({ event: "Stop", conversationId: base.conversationId, healthy: true })}\n`);
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
	});

	test("bounds reads of an oversized trusted event log instead of accepting a healthy Stop", () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		const log = path.join(req.directory, "events.jsonl");
		writeFileSync(log, `${JSON.stringify({ event: "PreInvocation", conversationId: base.conversationId, padding: "x".repeat(1024 * 1024) })}\n`);
		expect(countAgyJudgments(req)).toBe(64);
		expect(recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toBe(false);
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
	});

	test("caps deterministic events independently of the relevance judgment budget", () => {
		const req = request();
		for (let index = 0; index < 1024; index += 1) expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(countAgyJudgments(req)).toBe(0);
		const log = path.join(req.directory, "events.jsonl");
		const before = statSync(log).size;
		expect(() => recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toThrow("bound");
		expect(statSync(log).size).toBe(before);
		expect(recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toBe(false);
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
	});

	test("denies the next safe call after a relevance timeout without running JEV again", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const value = 1;\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		let judgments = 0;
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => {
			if (++judgments === 1) throw new Error("fixture timeout");
			return { answers: { relevant: { type: "noul", noul: 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] };
		} });
		try {
			const toolCall = { name: "view_file", args: { AbsolutePath: source } };
			expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: 1, toolCall })).decision).toBe("deny");
			expect(readFileSync(path.join(req.directory, "events.jsonl"), "utf8")).toContain('"degraded":true');
			expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: 2, toolCall })).decision).toBe("deny");
			expect(judgments).toBe(1);
			expect(runtime).toHaveBeenCalledTimes(1);
			expect(countAgyJudgments(req)).toBe(1);
			expect(verifyAgyLifecycle(req).healthy).toBe(false);
		} finally { runtime.mockRestore(); }
	});

	test("ordinary confident relevance denial does not poison subsequent calls", async () => {
		const req = request(false, true);
		const common = { ...base, workspacePaths: [root] };
		const source = path.join(root, "source.ts");
		writeFileSync(source, "export const value = 1;\n");
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...common })).toBe(true);
		let judgments = 0;
		const runtime = spyOn(jev, "createJevRuntime").mockReturnValue({ decide: async () => ({ answers: { relevant: { type: "noul", noul: ++judgments === 1 ? 0.1 : 0.99, confidence: 0.99 } }, model: "fixture", warnings: [] }) });
		try {
			const toolCall = { name: "view_file", args: { AbsolutePath: source } };
			expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: 1, toolCall })).decision).toBe("deny");
			expect((await invokeHook(req, "PreToolUse", { ...common, stepIdx: 2, toolCall })).decision).toBe("allow");
			expect(recordAgyHookEvent(req, { event: "PostToolUse", ...common, stepIdx: 2 })).toBe(true);
			expect((await invokeHook(req, "Stop", { ...common, terminationReason: "model_stop", fullyIdle: true })).decision).toBe("stop");
			expect(verifyAgyLifecycle(req).healthy).toBe(true);
		} finally { runtime.mockRestore(); }
	});

	test("binds a conversation and rejects a different conversation", () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base, conversationId: "conversation-b" })).toBe(false);
	});

	test("requires a healthy stop record for completion", () => {
		expect(verifyAgyLifecycle(request()).healthy).toBe(false);
	});

	test("verifies a trusted challenge denial for the exact fixture path", () => {
		const req = request(true);
		const fixture = "/tmp/challenge/fixture.txt";
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "PreToolUse", ...base, stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: fixture } } })).toBe(true);
		recordAgyToolDecision(req, 1, false, false);
		expect(recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toBe(true);
		expect(verifyAgyChallenge(req, "conversation-a", fixture)).toBe(true);
	});

	test("records tool execution errors and keeps the lifecycle incomplete", () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "PreToolUse", ...base, stepIdx: 3, toolCall: { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } } })).toBe(true);
		recordAgyToolDecision(req, 3, true, false);
		expect(recordAgyHookEvent(req, { event: "PostToolUse", ...base, stepIdx: 3, error: "native tool failed" })).toBe(true);
		expect(readFileSync(path.join(req.directory, "events.jsonl"), "utf8")).toContain('"status":"error"');
		expect(verifyAgyLifecycle(req).healthy).toBe(false);
		expect(recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toBe(false);
	});

	test("accepts only an allowed and completed tool before a healthy stop", () => {
		const req = request();
		expect(recordAgyHookEvent(req, { event: "PreInvocation", ...base })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "PreToolUse", ...base, stepIdx: 3, toolCall: { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } } })).toBe(true);
		recordAgyToolDecision(req, 3, true, false);
		expect(recordAgyHookEvent(req, { event: "PostToolUse", ...base, stepIdx: 3 })).toBe(true);
		expect(recordAgyHookEvent(req, { event: "Stop", ...base, terminationReason: "model_stop", fullyIdle: true })).toBe(true);
		expect(verifyAgyLifecycle(req).healthy).toBe(true);
	});
});
