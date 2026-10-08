import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgyRequest, digestAgyArguments, getAgyTranscriptPath, verifyAgyChallenge, verifyAgyLifecycle, type AgyRequest } from "./agy-state";

const OUTPUT_CAP = 1024 * 1024;
// ponytail: keep the single Linux -p argument well below the kernel's per-argument limit.
const MAX_AGY_PROMPT_BYTES = 64 * 1024;
const REVIEW_TIMEOUT_MS = 120_000;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 10_000;
const AGY_PLUGIN_NAME = "pi-pedstack-reviewer";
const AGY_AGENT_NAME = "pi-pedstack-reviewer";

export interface AgyFinding {
	severity: "high" | "moderate" | "low";
	summary: string;
	evidence: string;
	recommendedAction: string;
	autofixable: false;
	reviewer: string;
}

export function isGeminiModel(model: string): boolean {
	return /(?:^|\/)gemini-[^/]+$/i.test(model);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function parseResponseText(value: string): JsonValue {
	let text = value.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
	const fencedContent = fenced?.[1];
	if (fencedContent !== undefined) text = fencedContent.trim();
	try { return JSON.parse(text) as JsonValue; } catch { throw new Error("agy response is malformed JSON"); }
}

export function parseAgyFindings(stdout: string, reviewer: string): AgyFinding[] {
	if (Buffer.byteLength(stdout, "utf8") > OUTPUT_CAP) throw new Error("agy output exceeded 1 MiB");
	let envelope: unknown;
	try { envelope = JSON.parse(stdout); } catch { throw new Error("agy returned malformed JSON envelope"); }
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("agy returned an invalid JSON envelope");
	const record = envelope as Record<string, unknown>;
	const known = new Set(["status", "response", "conversation_id", "duration_seconds", "duration_api_ms", "num_turns", "total_cost_usd", "usage", "model", "stop_reason"]);
	if (Object.keys(record).some((key) => !known.has(key))) throw new Error("agy returned an unknown envelope field");
	if (record.status !== "SUCCESS" || typeof record.conversation_id !== "string" || !record.conversation_id || typeof record.response !== "string") throw new Error("agy did not return a successful complete response");
	let findings: unknown;
	try { findings = parseResponseText(record.response); } catch { throw new Error("agy response is not one complete JSON findings array"); }
	if (!Array.isArray(findings)) throw new Error("agy response is not a findings array");
	return findings.map((item): AgyFinding => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("agy finding is not an object");
		const finding = item as Record<string, unknown>;
		const severity = finding.severity;
		if (severity !== "high" && severity !== "moderate" && severity !== "low") throw new Error("agy finding has an invalid severity");
		for (const field of ["summary", "evidence", "recommendedAction"] as const) {
			if (typeof finding[field] !== "string" || !finding[field].trim() || Buffer.byteLength(finding[field], "utf8") > 4096) throw new Error(`agy finding has invalid ${field}`);
		}
		if (finding.autofixable !== false) throw new Error("agy finding must be explicitly non-autofixable");
		return {
			severity,
			summary: finding.summary as string,
			evidence: finding.evidence as string,
			recommendedAction: finding.recommendedAction as string,
			autofixable: false,
			reviewer,
		};
	});
}

export interface AgyCommandResult { code: number; stdout: string; stderr: string }
export type AgyCommand = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }) => Promise<AgyCommandResult>;

interface AgyOperationBudget {
	signal: AbortSignal;
	remainingMs(): number;
	dispose(): void;
}

function createAgyOperationBudget(parentSignal?: AbortSignal): AgyOperationBudget {
	const controller = new AbortController();
	const deadline = Date.now() + REVIEW_TIMEOUT_MS;
	const abort = (): void => controller.abort();
	const timer = setTimeout(abort, REVIEW_TIMEOUT_MS);
	if (parentSignal?.aborted) abort();
	else parentSignal?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		remainingMs(): number {
			const remaining = deadline - Date.now();
			if (remaining <= 0 && !controller.signal.aborted) abort();
			if (controller.signal.aborted || remaining <= 0) throw new Error("agy reviewer operation was aborted or exceeded its 120-second deadline");
			return remaining;
		},
		dispose(): void {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abort);
		},
	};
}

function commandWithinAgyBudget(command: AgyCommand, budget: AgyOperationBudget): AgyCommand {
	return async (binary, args, options = {}) => {
		const remaining = budget.remainingMs();
		const result = await command(binary, args, {
			...options,
			timeoutMs: Math.min(options.timeoutMs ?? PREFLIGHT_COMMAND_TIMEOUT_MS, remaining),
			signal: budget.signal,
		});
		budget.remainingMs();
		return result;
	};
}

export function createAgyCommand(spawnProcess: typeof spawn = spawn): AgyCommand {
	return (command, args, options = {}) => new Promise((resolve, reject) => {
	if (options.signal?.aborted) { reject(new Error("agy process aborted")); return; }
	const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let size = 0;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = (): void => { child.kill("SIGKILL"); finish(new Error("agy process aborted")); };
	const finish = (error?: Error, code = -1): void => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (error) { reject(error); return; }
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			resolve({ code, stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) });
		} catch {
			reject(new Error("agy process output is not valid UTF-8"));
		}
	};
	const cap = options.maxOutputBytes ?? OUTPUT_CAP;
	const consume = (target: "stdout" | "stderr", chunk: Buffer): void => {
		size += chunk.byteLength;
		if (size > cap) { child.kill("SIGKILL"); finish(new Error("agy process output exceeded 1 MiB")); return; }
		if (target === "stdout") stdout.push(chunk);
		else stderr.push(chunk);
	};
	child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
	child.on("error", (error) => finish(error));
	child.on("close", (code) => finish(undefined, code ?? -1));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("agy process timed out")); }, options.timeoutMs ?? REVIEW_TIMEOUT_MS);
	});
}

export const runAgyCommand: AgyCommand = createAgyCommand();

export interface AgyPreflightInput {
	model: string;
	workspace: string;
	shippedPluginDirectory: string;
	homeDirectory?: string;
	challenge?: (agent: string, model: string) => Promise<boolean>;
	command?: AgyCommand;
	signal?: AbortSignal;
}

interface AgyPreflightContext {
	snapshot: string;
	agyPath: string;
	bunPath: string;
	jevCommand: string;
	nodeDirectory: string;
	home: string;
	pluginDirectory: string;
	env: NodeJS.ProcessEnv;
}

function readOptional(file: string): string | undefined {
	let info;
	try { info = lstatSync(file); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`cannot inspect agy customization or plugin asset: ${file}`);
	}
	if (info.isSymbolicLink() || realpathSync(file) !== file) throw new Error(`agy customization or plugin asset must not contain symbolic links: ${file}`);
	if (!info.isFile()) throw new Error(`agy customization or plugin asset must be a regular file: ${file}`);
	if (info.size > OUTPUT_CAP) throw new Error(`agy customization or plugin asset exceeds 1 MiB: ${file}`);
	try { return readFileSync(file, "utf8"); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`cannot inspect agy customization or plugin asset: ${file}`);
	}
}

function customizationSnapshot(home: string, workspace: string, pluginDirectory: string): string {
	const paths = [
		path.join(home, ".gemini", "config", "hooks.json"),
		path.join(home, ".gemini", "antigravity-cli", "settings.json"),
		path.join(home, ".gemini", "antigravity-cli", "hooks.json"),
		path.join(home, ".gemini", "config", "agents", `${AGY_AGENT_NAME}.md`),
		path.join(workspace, ".agents", "hooks.json"),
		path.join(workspace, ".agents", "agents", `${AGY_AGENT_NAME}.md`),
		path.join(workspace, ".agents", "settings.json"),
		path.join(workspace, ".gemini", "settings.json"),
		...(["plugin.json", "hooks.json", "agents/pi-pedstack-reviewer.md", "guard.js"].map((file) => path.join(pluginDirectory, file))),
	];
	const hash = createHash("sha256");
	for (const file of paths) hash.update(file).update("\0").update(readOptional(file) ?? "<absent>").update("\0");
	for (const pluginRoot of [path.dirname(pluginDirectory), path.join(home, ".gemini", "antigravity-cli", "plugins")]) {
		try {
			for (const name of readdirSync(pluginRoot).sort()) hash.update(pluginRoot).update(name).update("\0");
		} catch { hash.update(`${pluginRoot}:<unavailable>`); }
	}
	return hash.digest("hex");
}

async function verifyRegisteredActivation(command: AgyCommand, agyPath: string, model: string, env: NodeJS.ProcessEnv): Promise<void> {
	const models = await command(agyPath, ["models"], { env });
	const modelAvailable = models.stdout.split(/\r?\n/).some((line) => line.split("\t", 1)[0]?.trim() === model);
	if (models.code !== 0 || !modelAvailable) throw new Error(`configured Gemini model is unavailable: ${model}`);
	const agents = await command(agyPath, ["agents"], { env });
	if (agents.code !== 0 || agents.stdout.split(/\r?\n/).filter((line) => line.trim() === AGY_AGENT_NAME).length !== 1) throw new Error("pi-pedstack reviewer agent is missing, disabled, or shadowed");
	const plugins = await command(agyPath, ["plugin", "list"], { env });
	const registeredPlugins = plugins.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (plugins.code !== 0 || registeredPlugins.length !== 1 || registeredPlugins[0] !== AGY_PLUGIN_NAME) throw new Error("additional agy plugins or invalid reviewer plugin registration are unsupported");
}

function resolvePluginDirectory(home: string): string {
	const pluginRoot = path.join(home, ".gemini", "config", "plugins");
	const pluginDirectory = path.join(pluginRoot, AGY_PLUGIN_NAME);
	let pluginEntries;
	try { pluginEntries = readdirSync(pluginRoot, { withFileTypes: true }); }
	catch { throw new Error("agy plugin installation directory is unavailable"); }
	if (pluginEntries.some((entry) => entry.name !== AGY_PLUGIN_NAME)) throw new Error("additional agy plugins are unsupported for guarded reviews");
	const reviewerEntry = pluginEntries.find((entry) => entry.name === AGY_PLUGIN_NAME);
	if (!reviewerEntry?.isDirectory() || reviewerEntry.isSymbolicLink()) throw new Error("agy reviewer plugin installation directory is unavailable or unsafe");
	let alternatePluginsFound = false;
	try {
		alternatePluginsFound = readdirSync(path.join(home, ".gemini", "antigravity-cli", "plugins")).length > 0;
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw new Error("cannot inspect alternate agy plugin directory");
	}
	if (alternatePluginsFound) throw new Error("plugins exist in an unsupported agy installation location");
	return pluginDirectory;
}

interface VerifiedAgyRuntime {
	agyPath: string;
	bunPath: string;
	jevCommand: string;
	nodeDirectory: string;
	env: NodeJS.ProcessEnv;
}

async function verifyAgyRuntime(command: AgyCommand, model: string): Promise<VerifiedAgyRuntime> {
	const agyPath = findExecutable("agy");
	const bunPath = findExecutable("bun");
	const jevCommand = findExecutable("cmd");
	const nodeDirectory = findExecutableDirectory("node");
	const env = safeEnvironment(agyPath, bunPath, jevCommand, nodeDirectory);
	const bunVersion = await command(bunPath, ["--version"], { env });
	if (bunVersion.code !== 0 || !/^\d+\.\d+\.\d+$/.test(bunVersion.stdout.trim())) throw new Error("Bun is required to run the installed reviewer guard");
	const version = await command(agyPath, ["--version"], { env });
	if (version.code !== 0 || version.stdout.trim() !== "1.3.1") throw new Error("guarded Gemini review supports only agy 1.3.1 on Linux");
	if (process.platform !== "linux") throw new Error("guarded Gemini review supports Linux only");
	const gitVersion = await command("/usr/bin/git", ["--version"], { env });
	if (gitVersion.code !== 0 || gitVersion.stdout.trim() !== "git version 2.47.3") throw new Error("guarded Git inspection requires Git 2.47.3");
	await verifyRegisteredActivation(command, agyPath, model, env);
	return { agyPath, bunPath, jevCommand, nodeDirectory, env };
}

function verifyAgyPluginAssets(pluginDirectory: string, shippedDirectory: string): void {
	if (lstatSync(pluginDirectory).isSymbolicLink() || lstatSync(shippedDirectory).isSymbolicLink()) throw new Error("plugin directory must not be a symbolic link");
	const installedPlugin = path.join(pluginDirectory, "plugin.json");
	const shippedPlugin = path.join(shippedDirectory, "plugin.json");
	if (readOptional(installedPlugin) !== readOptional(shippedPlugin) || !readOptional(installedPlugin)) throw new Error("installed pi-pedstack reviewer plugin does not match shipped assets");
	for (const asset of ["hooks.json", "agents/pi-pedstack-reviewer.md", "guard.js"]) {
		const installedPath = path.join(pluginDirectory, asset);
		const shippedPath = path.join(shippedDirectory, asset);
		if (lstatSync(installedPath).isSymbolicLink() || lstatSync(shippedPath).isSymbolicLink()) throw new Error(`plugin asset must not be a symbolic link: ${asset}`);
		const installed = readOptional(installedPath);
		const shipped = readOptional(shippedPath);
		if (installed === undefined || shipped === undefined || installed !== shipped) throw new Error(`installed reviewer plugin asset drift: ${asset}`);
	}
}

function rejectUnsupportedCustomizations(home: string, workspace: string, pluginDirectory: string): void {
	const customizationFiles = [
		path.join(home, ".gemini", "config", "hooks.json"),
		path.join(home, ".gemini", "antigravity-cli", "settings.json"),
		path.join(home, ".gemini", "antigravity-cli", "hooks.json"),
		path.join(home, ".gemini", "config", "agents", `${AGY_AGENT_NAME}.md`),
		path.join(workspace, ".agents", "hooks.json"),
		path.join(workspace, ".agents", "agents", `${AGY_AGENT_NAME}.md`),
		path.join(workspace, ".agents", "settings.json"),
		path.join(workspace, ".gemini", "settings.json"),
	];
	for (const file of customizationFiles) {
		const content = readOptional(file);
		if (content && file !== path.join(pluginDirectory, "hooks.json")) throw new Error(`unsupported external agy customization: ${file}`);
	}
}

function verifyAgyPluginSizes(pluginDirectory: string): void {
	for (const relative of ["hooks.json", "plugin.json", "agents/pi-pedstack-reviewer.md", "guard.js"]) {
		const file = path.join(pluginDirectory, relative);
		let info;
		try { info = lstatSync(file); }
		catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			throw new Error(`cannot inspect reviewer plugin asset: ${relative}`);
		}
		if (info.isSymbolicLink() || realpathSync(file) !== file) throw new Error(`plugin asset must not contain symbolic links: ${relative}`);
		if (!info.isFile()) throw new Error(`plugin asset must be a regular file: ${relative}`);
		if (info.size > OUTPUT_CAP) throw new Error(`reviewer plugin asset exceeds 1 MiB: ${relative}`);
	}
}

async function preflightAgyContext(input: AgyPreflightInput): Promise<AgyPreflightContext> {
	const command = input.command ?? runAgyCommand;
	const home = input.homeDirectory ?? process.env.HOME ?? "";
	if (realpathSync(input.workspace) !== input.workspace) throw new Error("review workspace must be canonical");
	const pluginDirectory = resolvePluginDirectory(home);
	verifyAgyPluginSizes(pluginDirectory);
	const runtime = await verifyAgyRuntime(command, input.model);
	verifyAgyPluginAssets(pluginDirectory, input.shippedPluginDirectory);
	rejectUnsupportedCustomizations(home, input.workspace, pluginDirectory);
	const beforeChallenge = customizationSnapshot(home, input.workspace, pluginDirectory);
	const challenge = input.challenge ?? ((agent, model) => runAgyChallenge(agent, model, command, runtime.agyPath, runtime.bunPath, runtime.jevCommand, runtime.nodeDirectory));
	if (!(await challenge(AGY_AGENT_NAME, input.model))) throw new Error("effective hook challenge did not prove guard activation");
	const afterChallenge = customizationSnapshot(home, input.workspace, pluginDirectory);
	if (beforeChallenge !== afterChallenge) throw new Error("agy customization or plugin assets changed during activation challenge");
	await verifyRegisteredActivation(command, runtime.agyPath, input.model, runtime.env);
	return { snapshot: afterChallenge, ...runtime, home, pluginDirectory };
}

export async function preflightAgy(input: AgyPreflightInput): Promise<string> {
	const budget = createAgyOperationBudget(input.signal);
	try {
		const command = commandWithinAgyBudget(input.command ?? runAgyCommand, budget);
		const context = await preflightAgyContext({ ...input, command });
		return context.snapshot;
	} finally {
		budget.dispose();
	}
}

function findExecutable(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return realpathSync(candidate);
		} catch { /* Continue through the inherited executable search path. */ }
	}
	throw new Error(`required executable is unavailable: ${name}`);
}

function findExecutableDirectory(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return realpathSync(directory);
		} catch { /* Continue through the inherited executable search path. */ }
	}
	throw new Error(`required executable is unavailable: ${name}`);
}

function safeEnvironment(agyPath: string, bunPath: string, jevCommand: string, nodeDirectory: string, request?: AgyRequest): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// ponytail: forward only runtime/keyring essentials and documented agy auth, never arbitrary secrets.
	for (const key of ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GEMINI_API_KEY"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	env.PATH = [...new Set([path.dirname(bunPath), path.dirname(agyPath), nodeDirectory, "/usr/local/bin", "/usr/bin", "/bin"])].join(path.delimiter);
	env.PEDSTACK_AGY_JEV_COMMAND = jevCommand;
	if (request) {
		env.PEDSTACK_AGY_REQUEST = request.requestPath;
		env.PEDSTACK_AGY_TOKEN = request.id;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_ATTR_NOSYSTEM = "1";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_NO_LAZY_FETCH = "1";
	return env;
}

function envelopeIdentity(stdout: string): { conversationId: string } {
	let value: unknown;
	try { value = JSON.parse(stdout) as unknown; } catch { throw new Error("agy returned malformed JSON envelope"); }
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("agy returned an invalid JSON envelope");
	const record = value as Record<string, unknown>;
	if (record.status !== "SUCCESS" || typeof record.conversation_id !== "string" || !record.conversation_id) throw new Error("agy invocation did not complete successfully");
	return { conversationId: record.conversation_id };
}

async function runAgyChallenge(agent: string, model: string, command: AgyCommand, agyPath: string, bunPath: string, jevCommand: string, nodeDirectory: string): Promise<boolean> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-pedstack-agy-challenge-"));
	const workspace = path.join(root, "workspace");
	const stateRoot = path.join(root, "state");
	const fixture = path.join(root, "challenge.txt");
	try {
		mkdirSync(workspace, { mode: 0o700 });
		mkdirSync(stateRoot, { mode: 0o700 });
		writeFileSync(fixture, "Harmless challenge fixture. Do not modify.\n", { mode: 0o600 });
		const request = createAgyRequest(stateRoot, { stage: "challenge", model, workspace: realpathSync(workspace), task: `Read the harmless challenge fixture at ${fixture}.` , challenge: true });
		const args = ["--model", model, "--agent", agent, "--mode", "plan", "--disable-slash-commands", "--output-format", "json", "--print-timeout", "45s", "-p", `Use view_file exactly once on ${fixture}. Stop immediately when the guard denies it.`];
		const result = await command(agyPath, args, { cwd: workspace, env: safeEnvironment(agyPath, bunPath, jevCommand, nodeDirectory, request), timeoutMs: 45_000, maxOutputBytes: OUTPUT_CAP });
		if (result.code !== 0) return false;
		const identity = envelopeIdentity(result.stdout);
		const transcriptPath = assertAgyLifecycle(request, identity.conversationId);
		return verifyAgyChallenge(request, identity.conversationId, fixture) && verifyAgyTranscript(request, transcriptPath, identity.conversationId);
	} catch {
		return false;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export interface AgyReviewInput {
	model: string;
	reviewer: string;
	stage: string;
	repoRoot: string;
	task: string;
	prompt: string;
	thinkingLevel?: string;
	stateRoot: string;
	shippedPluginDirectory: string;
	command?: AgyCommand;
	signal?: AbortSignal;
}

function byteExcerpt(value: string, limit: number): string {
	const bytes = Buffer.from(value, "utf8");
	return bytes.byteLength <= limit ? value : new TextDecoder().decode(bytes.subarray(0, limit));
}

function nativeEffort(level: string | undefined): string | undefined {
	if (level === undefined) return undefined;
	if (["low", "medium", "high", "xhigh", "max"].includes(level)) return level;
	throw new Error(`Unsupported agy effort level: ${level}`);
}

export async function runAgyReviewer(input: AgyReviewInput): Promise<AgyFinding[]> {
	if (!isGeminiModel(input.model)) throw new Error("agy runner received a non-Gemini model");
	const reviewerTask = `${input.task}\n\nAssigned review material:\n${input.prompt}`;
	if (Buffer.byteLength(reviewerTask, "utf8") > MAX_AGY_PROMPT_BYTES) throw new Error("agy review prompt exceeds the 64 KiB safe process-argument limit");
	const budget = createAgyOperationBudget(input.signal);
	try {
		const command = commandWithinAgyBudget(input.command ?? runAgyCommand, budget);
		const workspace = realpathSync(input.repoRoot);
		const preflight = await preflightAgyContext({ model: input.model, workspace, shippedPluginDirectory: input.shippedPluginDirectory, command });
		const { snapshot: configSnapshot, agyPath, bunPath, jevCommand, nodeDirectory, home, pluginDirectory } = preflight;
		const effort = nativeEffort(input.thinkingLevel);
		await verifyRegisteredActivation(command, agyPath, input.model, safeEnvironment(agyPath, bunPath, jevCommand, nodeDirectory));
		const taskExcerpt = byteExcerpt(`${input.task}\n\n${input.prompt}`, 4096);
		const request = createAgyRequest(input.stateRoot, { stage: input.stage, model: input.model, workspace, task: taskExcerpt });
		const args = ["--model", input.model, "--agent", AGY_AGENT_NAME, "--mode", "plan", "--disable-slash-commands", "--output-format", "json", "--print-timeout", "120s"];
		if (effort) args.push("--effort", effort);
		args.push("-p", reviewerTask);
		const env = safeEnvironment(agyPath, bunPath, jevCommand, nodeDirectory, request);
		if (customizationSnapshot(home, workspace, pluginDirectory) !== configSnapshot) throw new Error("agy customization or plugin assets changed before guarded review launch");
		const result = await command(agyPath, args, { cwd: workspace, env, timeoutMs: REVIEW_TIMEOUT_MS, maxOutputBytes: OUTPUT_CAP });
		if (result.code !== 0) throw new Error(`agy reviewer process exited with code ${result.code}`);
		const identity = envelopeIdentity(result.stdout);
		const transcriptPath = assertAgyLifecycle(request, identity.conversationId);
		if (!verifyAgyTranscript(request, transcriptPath, identity.conversationId)) throw new Error("agy native transcript does not reconcile with guard events");
		await verifyRegisteredActivation(command, agyPath, input.model, safeEnvironment(agyPath, bunPath, jevCommand, nodeDirectory));
		if (customizationSnapshot(home, workspace, pluginDirectory) !== configSnapshot) throw new Error("agy customization or plugin assets changed during guarded review");
		return parseAgyFindings(result.stdout, input.reviewer);
	} finally {
		budget.dispose();
	}
}

interface TranscriptToolCall { stepIdx: number; name: string; argsDigest: string }
interface TranscriptParseState { calls: TranscriptToolCall[]; sawStepIndex: boolean }

function collectTranscriptCalls(value: unknown, state: TranscriptParseState, inheritedStep?: number, depth = 0): void {
	if (depth > 32 || state.calls.length > 64) throw new Error("agy transcript structure exceeds its bounds");
	if (Array.isArray(value)) {
		for (const item of value) collectTranscriptCalls(item, state, inheritedStep, depth + 1);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	const stepIdx = Number.isSafeInteger(record.step_index) ? record.step_index as number : inheritedStep;
	if (Number.isSafeInteger(record.step_index)) state.sawStepIndex = true;
	if ("tool_calls" in record && !Array.isArray(record.tool_calls)) throw new Error("agy transcript tool_calls has an unknown schema");
	if (Array.isArray(record.tool_calls)) {
		for (const rawCall of record.tool_calls) {
			if (typeof rawCall !== "object" || rawCall === null || Array.isArray(rawCall)) throw new Error("agy transcript contains an unbound tool call");
			const call = rawCall as Record<string, unknown>;
			const callStep = Number.isSafeInteger(call.step_index) ? call.step_index : stepIdx;
			if (!Number.isSafeInteger(callStep)) throw new Error("agy transcript contains an unbound tool call");
			const name = call.name;
			let args = call.args ?? call.arguments ?? call.input;
			if (typeof args === "string") {
				try { args = JSON.parse(args) as unknown; } catch { throw new Error("agy transcript contains malformed tool arguments"); }
			}
			if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("agy transcript contains an unknown tool-call schema");
			state.calls.push({ stepIdx: callStep as number, name, argsDigest: digestAgyArguments(args) });
		}
	}
	for (const [key, child] of Object.entries(record)) {
		if (key !== "tool_calls") collectTranscriptCalls(child, state, stepIdx, depth + 1);
	}
}

export function verifyAgyTranscript(request: AgyRequest, transcriptPath: string, conversationId: string, home = process.env.HOME ?? ""): boolean {
	try {
		const stat = lstatSync(transcriptPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OUTPUT_CAP) return false;
		const root = path.join(home, ".gemini", "antigravity-cli", "brain");
		const expected = path.join(root, conversationId, ".system_generated", "logs", "transcript.jsonl");
		if (path.resolve(transcriptPath) !== expected || realpathSync(transcriptPath) !== expected) return false;
		const content = readFileSync(transcriptPath, "utf8");
		const parsed: TranscriptParseState = { calls: [], sawStepIndex: false };
		for (const line of content.split("\n").filter(Boolean)) {
			let item: unknown;
			try { item = JSON.parse(line) as unknown; } catch { return false; }
			collectTranscriptCalls(item, parsed);
		}
		if (!parsed.sawStepIndex) return false;
		const calls = parsed.calls;
		const lifecycle = verifyAgyLifecycle(request);
		if (!lifecycle.healthy) return false;
		const hooked = lifecycle.events.filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && !Array.isArray(event) && "event" in event && event.event === "PreToolUse")
			.map((event) => ({ stepIdx: event.stepIdx, name: event.name, argsDigest: event.argsDigest }));
		if (calls.length !== hooked.length) return false;
		const toKey = (call: TranscriptToolCall | Record<string, unknown>) => `${call.stepIdx}:${call.name}:${call.argsDigest}`;
		return calls.map(toKey).sort().join("\n") === hooked.map(toKey).sort().join("\n");
	} catch {
		return false;
	}
}

export function assertAgyLifecycle(request: AgyRequest, expectedConversationId: string): string {
	const lifecycle = verifyAgyLifecycle(request);
	if (!lifecycle.healthy) throw new Error("agy reviewer guard lifecycle is incomplete or degraded");
	if (!lifecycle.events.some((event) => typeof event === "object" && event !== null && "conversationId" in event && event.conversationId === expectedConversationId)) throw new Error("agy reviewer conversation identity does not match hook records");
	const transcriptPath = getAgyTranscriptPath(request);
	if (!transcriptPath) throw new Error("agy reviewer transcript path is missing or inconsistent");
	return transcriptPath;
}
