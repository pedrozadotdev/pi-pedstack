import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgyCommand, isGeminiModel, parseAgyFindings, preflightAgy, runAgyReviewer, verifyAgyTranscript, type AgyCommand, type AgyReviewInput } from "../extensions/ce-core/review/agy-runner.js";
import { createAgyRequest, recordAgyHookEvent, recordAgyToolDecision } from "../extensions/ce-core/review/agy-state";
import * as agyRunner from "../extensions/ce-core/review/agy-runner.js";

function fakeSpawn(output?: string | Buffer, splitAt?: number): typeof spawn {
	return (() => {
		const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => true;
		if (output !== undefined) queueMicrotask(() => {
			const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
			if (splitAt === undefined) child.stdout.end(bytes);
			else { child.stdout.write(bytes.subarray(0, splitAt)); child.stdout.end(bytes.subarray(splitAt)); }
			child.emit("close", 0, null);
		});
		return child;
	}) as unknown as typeof spawn;
}

let roots: string[] = [];
const previousEnvironment = new Map<string, string | undefined>();
function setEnvironment(key: string, value: string): void {
	if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key]);
	process.env[key] = value;
}
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	previousEnvironment.clear();
});
function preflightFixture(gitVersion = "git version 2.47.3", modelCatalogue = "gemini-test-model") {
	const root = mkdtempSync(path.join(tmpdir(), "agy-runner-test-"));
	roots.push(root);
	const home = path.join(root, "home");
	const plugin = path.join(root, "shipped");
	const workspace = path.join(root, "workspace");
	const bin = path.join(root, "bin");
	const jevBin = path.join(root, "jev-bin");
	const nodeBin = path.join(root, "node-bin");
	mkdirSync(bin);
	mkdirSync(jevBin);
	mkdirSync(nodeBin);
	symlinkSync(process.execPath, path.join(nodeBin, "node"));
	for (const name of ["agy", "bun"]) {
		writeFileSync(path.join(bin, name), "fixture executable; command boundary is injected");
		chmodSync(path.join(bin, name), 0o700);
	}
	const jevCommand = path.join(jevBin, "cmd");
	writeFileSync(jevCommand, `#!/usr/bin/env node\nif (!process.env.PATH.split(${JSON.stringify(path.delimiter)}).includes(${JSON.stringify(nodeBin)})) process.exit(41);\nprocess.stdout.write("jev fixture spawned\\n");\n`);
	chmodSync(jevCommand, 0o700);
	setEnvironment("PATH", [bin, jevBin, nodeBin].join(path.delimiter));
	mkdirSync(path.join(home, ".gemini", "config", "plugins", "pi-pedstack-reviewer"), { recursive: true });
	mkdirSync(path.join(plugin, "agents"), { recursive: true });
	mkdirSync(workspace);
	for (const relative of ["plugin.json", "hooks.json", "agents/pi-pedstack-reviewer.md", "guard.js"]) {
		cpSync(path.resolve(import.meta.dir, `../plugins/agy-reviewer/${relative}`), path.join(plugin, relative));
		cpSync(path.join(plugin, relative), path.join(home, ".gemini", "config", "plugins", "pi-pedstack-reviewer", relative));
	}
	const calls: Array<{ binary: string; args: string[] }> = [];
	const command = async (binary: string, args: string[]) => {
		calls.push({ binary, args });
		const stdout = binary === "/usr/bin/git" ? gitVersion : args[0] === "--version" ? "1.3.1" : args[0] === "models" ? modelCatalogue : args[0] === "agents" ? "pi-pedstack-reviewer" : "pi-pedstack-reviewer";
		return { code: 0, stdout, stderr: "" };
	};
	return { root, home, plugin, workspace, bin, jevBin, nodeBin, jevCommand, command, calls };
}

function reviewFixture(drift?: (installed: string, workspace: string) => void) {
	const fixture = preflightFixture();
	const bin = fixture.bin;
	const stateRoot = path.join(fixture.root, "state");
	mkdirSync(stateRoot);
	setEnvironment("HOME", fixture.home);
	setEnvironment("PATH", [bin, fixture.jevBin, fixture.nodeBin].join(path.delimiter));
	const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined; timeoutMs?: number; signal?: AbortSignal }> = [];
	let registrations = 0;
	const command: AgyCommand = async (binary, args, options = {}) => {
		calls.push({ args, env: options.env, cwd: options.cwd, timeoutMs: options.timeoutMs, signal: options.signal });
		if (args[0] === "models" && ++registrations === 3) drift?.(path.join(fixture.home, ".gemini", "config", "plugins", "pi-pedstack-reviewer"), fixture.workspace);
		if (!args.includes("-p")) return fixture.command(binary, args);
		const requestPath = options.env!.PEDSTACK_AGY_REQUEST!;
		const request = { requestPath, directory: path.dirname(requestPath), id: options.env!.PEDSTACK_AGY_TOKEN! };
		const data = JSON.parse(readFileSync(requestPath, "utf8")) as { model: string; workspace: string; challenge?: boolean };
		const conversationId = data.challenge ? "challenge-conversation" : "review-conversation";
		const transcriptPath = path.join(fixture.home, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
		mkdirSync(path.dirname(transcriptPath), { recursive: true });
		const common = { conversationId, modelName: data.model, workspacePaths: [data.workspace], transcriptPath };
		expect(recordAgyHookEvent(request, { ...common, event: "PreInvocation" })).toBe(true);
		const toolCall = { name: "view_file", args: { AbsolutePath: path.join(path.dirname(options.cwd!), "challenge.txt") } };
		if (data.challenge) {
			expect(recordAgyHookEvent(request, { ...common, event: "PreToolUse", stepIdx: 0, toolCall })).toBe(true);
			recordAgyToolDecision(request, 0, false, false, false);
		}
		writeFileSync(transcriptPath, `${JSON.stringify({ step_index: 0, tool_calls: data.challenge ? [toolCall] : [] })}\n`);
		expect(recordAgyHookEvent(request, { ...common, event: "Stop", terminationReason: "model_stop", fullyIdle: true })).toBe(true);
		return { code: 0, stdout: JSON.stringify({ status: "SUCCESS", response: "[]", conversation_id: conversationId }), stderr: "" };
	};
	const input: AgyReviewInput = { model: "gemini-test-model", reviewer: "Reviewer", stage: "04-review", repoRoot: fixture.workspace, task: "inspect source", prompt: "source fixture", stateRoot, shippedPluginDirectory: fixture.plugin, command };
	return { input, calls, bin, jevBin: fixture.jevBin, nodeBin: fixture.nodeBin, jevCommand: fixture.jevCommand, home: fixture.home };
}

describe("agy runner contracts", () => {
	test("uses a minimal environment for preflight, challenge and review without forwarding unrelated secrets", async () => {
		const fixture = reviewFixture();
		const unrelated = ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "APPLICATION_SECRET", "AGY_UNKNOWN_TOKEN", "BASH_ENV", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "GIT_CONFIG_COUNT"];
		for (const key of unrelated) setEnvironment(key, "dummy-unrelated-fixture");
		setEnvironment("GEMINI_API_KEY", "dummy-agy-auth-fixture");
		setEnvironment("LANG", "C.UTF-8");
		await expect(runAgyReviewer(fixture.input)).resolves.toEqual([]);
		expect(fixture.calls.filter((call) => call.args.includes("-p"))).toHaveLength(2);
		const sanitized = fixture.calls.find((call) => call.args.includes("-p"))?.env;
		if (!sanitized?.PEDSTACK_AGY_JEV_COMMAND) throw new Error("sanitized environment omitted the verified JEV command");
		const spawned = spawnSync(sanitized.PEDSTACK_AGY_JEV_COMMAND, ["--version"], { env: sanitized });
		expect(spawned.error).toBeUndefined();
		expect(spawned.status).toBe(0);
		expect(spawned.stdout.toString()).toBe("jev fixture spawned\n");
		for (const call of fixture.calls) {
			expect(call.env).toBeDefined();
			for (const key of unrelated) expect(call.env![key]).toBeUndefined();
			expect(call.env!.GEMINI_API_KEY).toBe("dummy-agy-auth-fixture");
			expect(call.env!.HOME).toBe(fixture.home);
			expect(call.env!.LANG).toBe("C.UTF-8");
			expect(call.env!.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(call.env!.PATH!.split(path.delimiter)).toEqual([fixture.bin, fixture.nodeBin, "/usr/local/bin", "/usr/bin", "/bin"]);
			expect(call.env!.PEDSTACK_AGY_JEV_COMMAND).toBe(fixture.jevCommand);
			expect(call.env!.PATH).not.toContain(fixture.jevBin);
		}
	});

	test.each(["hooks.json", "guard.js", "workspace hooks"])("rejects %s drift after the challenge before exposing the repository", async (asset) => {
		const fixture = reviewFixture((installed, workspace) => {
			const target = asset === "workspace hooks" ? path.join(workspace, ".agents", "hooks.json") : path.join(installed, asset);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, "changed fixture customization");
		});
		await expect(runAgyReviewer(fixture.input)).rejects.toThrow("changed");
		expect(fixture.calls.filter((call) => call.args.includes("-p") && call.cwd === fixture.input.repoRoot)).toHaveLength(0);
	});
	test("shares one deadline signal and bounds every preflight, challenge, and review command", async () => {
		const fixture = reviewFixture();
		fixture.input.signal = new AbortController().signal;
		const command = fixture.input.command!;
		const originalNow = Date.now;
		let now = originalNow();
		let delayed = false;
		Date.now = () => now;
		fixture.input.command = async (binary, args, options) => {
			const result = await command(binary, args, options);
			if (!delayed && args[0] === "--version" && binary !== "/usr/bin/git") {
				delayed = true;
				now += 30_000;
			}
			return result;
		};

		try {
			await expect(runAgyReviewer(fixture.input)).resolves.toEqual([]);
		} finally {
			Date.now = originalNow;
		}
		expect(fixture.calls.length).toBeGreaterThan(4);
		expect(fixture.calls.every((call) => call.signal !== undefined)).toBe(true);
		expect(new Set(fixture.calls.map((call) => call.signal)).size).toBe(1);
		const preflightCalls = fixture.calls.filter((call) => !call.args.includes("-p"));
		expect(preflightCalls.every((call) => call.timeoutMs !== undefined && call.timeoutMs > 0 && call.timeoutMs <= 10_000)).toBe(true);
		const printCalls = fixture.calls.filter((call) => call.args.includes("-p"));
		const challenge = printCalls.find((call) => call.cwd !== fixture.input.repoRoot);
		const review = printCalls.find((call) => call.cwd === fixture.input.repoRoot);
		expect(challenge?.timeoutMs).toBeGreaterThan(0);
		expect(challenge?.timeoutMs).toBeLessThanOrEqual(45_000);
		expect(review?.timeoutMs).toBe(90_000);
	});

	test("cancels before the next preflight command when the caller aborts", async () => {
		const fixture = reviewFixture();
		const controller = new AbortController();
		fixture.input.signal = controller.signal;
		const command = fixture.input.command!;
		fixture.input.command = async (binary, args, options) => {
			const result = await command(binary, args, options);
			if (args[0] === "--version") controller.abort();
			return result;
		};

		await expect(runAgyReviewer(fixture.input)).rejects.toThrow(/abort|cancel|timed out/i);
		expect(fixture.calls).toHaveLength(1);
		expect(fixture.calls[0]?.signal?.aborted).toBe(true);
		expect(fixture.calls.some((call) => call.cwd === fixture.input.repoRoot)).toBe(false);
	});

	test("still rejects configuration drift observed after repository review", async () => {
		const fixture = reviewFixture();
		const command = fixture.input.command!;
		fixture.input.command = async (binary, args, options) => {
			const result = await command(binary, args, options);
			if (args.includes("-p") && options?.cwd === fixture.input.repoRoot) {
				writeFileSync(path.join(fixture.home, ".gemini", "config", "plugins", "pi-pedstack-reviewer", "guard.js"), "post-run drift fixture");
			}
			return result;
		};
		await expect(runAgyReviewer(fixture.input)).rejects.toThrow("changed during guarded review");
		expect(fixture.calls.filter((call) => call.args.includes("-p") && call.cwd === fixture.input.repoRoot)).toHaveLength(1);
	});

	test("accepts a reviewer prompt exactly at the safe process-argument byte bound", async () => {
		const fixture = reviewFixture();
		const prefix = "\n\nAssigned review material:\n";
		fixture.input.task = "";
		fixture.input.prompt = "x".repeat(64 * 1024 - Buffer.byteLength(prefix));

		await expect(runAgyReviewer(fixture.input)).resolves.toEqual([]);
		const launch = fixture.calls.find((call) => call.cwd === fixture.input.repoRoot && call.args.includes("-p"));
		expect(launch).toBeDefined();
		expect(Buffer.byteLength(launch!.args[launch!.args.indexOf("-p") + 1])).toBe(64 * 1024);
	});

	test("rejects a reviewer prompt one byte over the safe argument bound before launch", async () => {
		const fixture = reviewFixture();
		const prefix = "\n\nAssigned review material:\n";
		fixture.input.task = "";
		fixture.input.prompt = "x".repeat(64 * 1024 - Buffer.byteLength(prefix) + 1);

		await expect(runAgyReviewer(fixture.input)).rejects.toThrow("64 KiB");
		expect(fixture.calls.some((call) => call.cwd === fixture.input.repoRoot && call.args.includes("-p"))).toBe(false);
	});

	test("reconciles every transcript tool call with its trusted hook decision", () => {
		const root = mkdtempSync(path.join(tmpdir(), "agy-transcript-test-"));
		roots.push(root);
		const home = path.join(root, "home");
		const stateRoot = path.join(root, "state");
		const conversationId = "conversation-a";
		const workspace = "/repo";
		const transcriptPath = path.join(home, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
		mkdirSync(path.dirname(transcriptPath), { recursive: true });
		mkdirSync(stateRoot);
		const args = { AbsolutePath: "/repo/source.ts" };
		writeFileSync(transcriptPath, `${JSON.stringify({ step_index: 3, tool_calls: [{ name: "view_file", args }] })}${String.fromCharCode(10)}`);
		const request = createAgyRequest(stateRoot, { stage: "04-review", model: "gemini-test", workspace, task: "review", challenge: false });
		const common = { conversationId, modelName: "gemini-test", workspacePaths: [workspace], transcriptPath };
		expect(recordAgyHookEvent(request, { ...common, event: "PreInvocation" })).toBe(true);
		expect(recordAgyHookEvent(request, { ...common, event: "PreToolUse", stepIdx: 3, toolCall: { name: "view_file", args } })).toBe(true);
		recordAgyToolDecision(request, 3, true, false);
		expect(recordAgyHookEvent(request, { ...common, event: "PostToolUse", stepIdx: 3 })).toBe(true);
		expect(recordAgyHookEvent(request, { ...common, event: "Stop", terminationReason: "model_stop", fullyIdle: true })).toBe(true);
		expect(verifyAgyTranscript(request, transcriptPath, conversationId, home)).toBe(true);
		writeFileSync(transcriptPath, `${JSON.stringify({ step_index: 3, tool_calls: [] })}\n`);
		expect(verifyAgyTranscript(request, transcriptPath, conversationId, home)).toBe(false);
	});

	test("preflights exact installed assets and requires the effective-hook challenge", async () => {
		const fixture = preflightFixture();
		const snapshot = await preflightAgy({
			model: "gemini-test-model",
			workspace: fixture.workspace,
			shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home,
			command: fixture.command,
			challenge: async (agent: string, model: string) => agent === "pi-pedstack-reviewer" && model === "gemini-test-model",
		});
		expect(snapshot).toMatch(/^[a-f0-9]{64}$/);
		expect(fixture.calls).toContainEqual({ binary: "/usr/bin/git", args: ["--version"] });
	});

	test("matches the exact identifier column in the native tab-separated model catalogue", async () => {
		const fixture = preflightFixture("git version 2.47.3", "gemini-test-model\tGemini Test Model\n");
		let challenged = false;
		const snapshot = await preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		});
		expect(snapshot).toMatch(/^[a-f0-9]{64}$/);
		expect(challenged).toBe(true);
	});

	test("rejects a provider-qualified model when only its unqualified identifier is available", async () => {
		const fixture = preflightFixture("git version 2.47.3", "gemini-test-model\tGemini Test Model\n");
		let challenged = false;
		await expect(preflightAgy({
			model: "provider/gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("configured Gemini model is unavailable");
		expect(challenged).toBe(false);
	});

	test("rejects any additional registered plugin before the activation challenge", async () => {
		const fixture = preflightFixture();
		let challenged = false;
		const command: AgyCommand = async (binary, args) => args[0] === "plugin"
			? { code: 0, stdout: "pi-pedstack-reviewer\\nother-plugin\\n", stderr: "" }
			: fixture.command(binary, args);
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("additional agy plugins");
		expect(challenged).toBe(false);
	});

	test.each(["primary", "alternate"])("rejects symlinked plugin-root entries in the %s location before challenge", async (location) => {
		const fixture = preflightFixture();
		const pluginRoot = location === "primary"
			? path.join(fixture.home, ".gemini", "config", "plugins")
			: path.join(fixture.home, ".gemini", "antigravity-cli", "plugins");
		const target = path.join(fixture.root, "extra-plugin-target");
		mkdirSync(target);
		mkdirSync(pluginRoot, { recursive: true });
		symlinkSync(target, path.join(pluginRoot, "extra-plugin"), "dir");
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow();
		expect(challenged).toBe(false);
	});

	test.each(["git version 2.47.2", "git version 2.48.0", "git version 2.47.3.vendor"])("rejects unsupported Git runtime %s before the activation challenge", async (gitVersion) => {
		const fixture = preflightFixture(gitVersion);
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model",
			workspace: fixture.workspace,
			shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home,
			command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("Git 2.47.3");
		expect(challenged).toBe(false);
	});

	test("aborts when additional global hook configuration is present", async () => {
		const fixture = preflightFixture();
		writeFileSync(path.join(fixture.home, ".gemini", "config", "hooks.json"), JSON.stringify({ external: { PreToolUse: [] } }));
		await expect(preflightAgy({ model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin, homeDirectory: fixture.home, command: fixture.command, challenge: async () => true })).rejects.toThrow("unsupported external agy customization");
	});

	test("rejects oversized workspace customization before the activation challenge", async () => {
		const fixture = preflightFixture();
		const settings = path.join(fixture.workspace, ".gemini", "settings.json");
		mkdirSync(path.dirname(settings), { recursive: true });
		writeFileSync(settings, "x".repeat(1024 * 1024 + 1));
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("exceeds 1 MiB");
		expect(challenged).toBe(false);
	});

	test("rejects symlinked workspace customization before the activation challenge", async () => {
		const fixture = preflightFixture();
		const settings = path.join(fixture.workspace, ".gemini", "settings.json");
		const target = path.join(fixture.root, "external-settings.json");
		mkdirSync(path.dirname(settings), { recursive: true });
		writeFileSync(target, "");
		symlinkSync(target, settings);
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("symbolic link");
		expect(challenged).toBe(false);
	});

	test("rejects workspace customization reached through a symlinked directory", async () => {
		const fixture = preflightFixture();
		const externalConfig = path.join(fixture.root, "external-config");
		mkdirSync(externalConfig);
		writeFileSync(path.join(externalConfig, "settings.json"), "");
		symlinkSync(externalConfig, path.join(fixture.workspace, ".gemini"), "dir");
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("symbolic link");
		expect(challenged).toBe(false);
	});

	test("rejects non-regular workspace customization paths before the activation challenge", async () => {
		const fixture = preflightFixture();
		const settings = path.join(fixture.workspace, ".gemini", "settings.json");
		mkdirSync(settings, { recursive: true });
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("regular file");
		expect(challenged).toBe(false);
	});

	test("rejects oversized installed plugin assets before comparing asset contents", async () => {
		const fixture = preflightFixture();
		const installedGuard = path.join(fixture.home, ".gemini", "config", "plugins", "pi-pedstack-reviewer", "guard.js");
		writeFileSync(installedGuard, "x".repeat(1024 * 1024 + 1));
		let challenged = false;
		await expect(preflightAgy({
			model: "gemini-test-model", workspace: fixture.workspace, shippedPluginDirectory: fixture.plugin,
			homeDirectory: fixture.home, command: fixture.command,
			challenge: async () => { challenged = true; return true; },
		})).rejects.toThrow("exceeds 1 MiB");
		expect(challenged).toBe(false);
	});

	test("runs commands shell-free with output bounds", async () => {
		const result = await createAgyCommand(fakeSpawn("bounded"))("agy", [], { maxOutputBytes: 16 });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("bounded");
		await expect(createAgyCommand(fakeSpawn("too-large-output"))("agy", [], { maxOutputBytes: 4 })).rejects.toThrow("output exceeded");
	});

	test("preserves UTF-8 split across output chunks and rejects malformed output", async () => {
		const summary = "Review café";
		const bytes = Buffer.from(summary, "utf8");
		const splitAt = bytes.indexOf(Buffer.from("é")) + 1;
		const result = await createAgyCommand(fakeSpawn(bytes, splitAt))("agy", []);
		expect(result.stdout).toBe(summary);
		await expect(createAgyCommand(fakeSpawn(Buffer.from([0xc3])))("agy", [])).rejects.toThrow("valid UTF-8");
	});

	test("aborts a running agy subprocess when its signal is cancelled", async () => {
		const controller = new AbortController();
		const pending = createAgyCommand(fakeSpawn())("agy", [], { signal: controller.signal, timeoutMs: 10000 });
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	test("does not expose an unused request-construction wrapper from the runner", () => {
		expect(Object.hasOwn(agyRunner, "createAgyReviewRequest")).toBe(false);
	});

	test("detects Gemini components without rewriting configured identifiers", () => {
		expect(isGeminiModel("gemini-3.8-flash-high")).toBe(true);
		expect(isGeminiModel("provider/gemini-3.8-flash-high")).toBe(true);
		expect(isGeminiModel("not-gemini-3.8-flash-high")).toBe(false);
	});

	test("accepts an empty findings array only in a valid successful envelope", () => {
		const findings = parseAgyFindings(JSON.stringify({ status: "SUCCESS", response: "[]", conversation_id: "c-1" }), "Reviewer");
		expect(findings).toEqual([]);
	});

	test("rejects successful process envelopes with malformed or truncated findings", () => {
		expect(() => parseAgyFindings(JSON.stringify({ status: "SUCCESS", response: "[] trailing", conversation_id: "c-1" }), "Reviewer")).toThrow();
		expect(() => parseAgyFindings(JSON.stringify({ status: "SUCCESS", response: "[", conversation_id: "c-1" }), "Reviewer")).toThrow();
	});

	test("rejects non-string severities without coercion", () => {
		for (const severity of [["high"], null, {}, 1, false]) {
			const finding = { severity, summary: "Finding", evidence: "source.ts:1", recommendedAction: "Fix it", autofixable: false };
			const response = JSON.stringify({ status: "SUCCESS", response: JSON.stringify([finding]), conversation_id: "c-1" });
			expect(() => parseAgyFindings(response, "Reviewer")).toThrow("invalid severity");
		}
	});

	test("rejects the entire findings array when a later severity is malformed", () => {
		const valid = { severity: "high", summary: "Valid finding", evidence: "source.ts:1", recommendedAction: "Fix it", autofixable: false };
		const invalid = { severity: ["high"], summary: "Malformed finding", evidence: "source.ts:2", recommendedAction: "Fix it", autofixable: false };
		const response = JSON.stringify({ status: "SUCCESS", response: JSON.stringify([valid, invalid]), conversation_id: "c-1" });
		expect(() => parseAgyFindings(response, "Reviewer")).toThrow("invalid severity");
	});
});
