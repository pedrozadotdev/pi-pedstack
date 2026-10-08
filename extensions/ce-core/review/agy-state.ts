import { appendFileSync, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { AGY_TOOL_LIMITS } from "./agy-policy";

export interface AgyRequestInput {
	stage: string;
	model: string;
	workspace: string;
	task: string;
	challenge?: boolean;
}
export interface AgyRequest {
	id: string;
	directory: string;
	requestPath: string;
}
export interface AgyHookEvent {
	event: string;
	conversationId?: unknown;
	modelName?: unknown;
	workspacePaths?: unknown;
	transcriptPath?: unknown;
	toolCall?: { name?: unknown; args?: unknown };
	stepIdx?: unknown;
	error?: unknown;
	fullyIdle?: unknown;
	terminationReason?: unknown;
}

interface StoredRequest extends AgyRequestInput {
	id: string;
	taskDigest: string;
	task: string;
}
interface StoredEvent {
	event: string;
	conversationId: string;
	stepIdx?: number;
	name?: string;
	argsDigest?: string;
	transcriptPath?: string;
	status?: "pending" | "allowed" | "denied" | "complete" | "error";
	degraded?: boolean;
	judged?: boolean;
	challengeTarget?: string;
	healthy?: boolean;
}

function safeJson(pathname: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(pathname, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function digestAgyArguments(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 1024;

function readEvents(request: AgyRequest): StoredEvent[] {
	if (lstatSync(path.join(request.directory, "incomplete"), { throwIfNoEntry: false })) throw new Error("trusted agy event log is incomplete");
	const fd = openSync(path.join(request.directory, "events.jsonl"), "r");
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) throw new Error("trusted agy event log exceeds its byte bound");
		// Read at most the stat size + one byte; concurrent growth is incomplete, never a truncated success.
		const buffer = Buffer.alloc(stat.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = readSync(fd, buffer, size, buffer.length - size, null);
			if (read === 0) break;
			size += read;
		}
		if (size !== stat.size) throw new Error("trusted agy event log changed during bounded read");
		const lines = buffer.toString("utf8", 0, size).split("\n").filter(Boolean);
		if (lines.length > MAX_EVENTS) throw new Error("trusted agy event log exceeds its event bound");
		return lines.map((line) => {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid trusted agy event");
			return value as StoredEvent;
		});
	} finally { closeSync(fd); }
}

function writeEvent(request: AgyRequest, event: StoredEvent): void {
	const log = path.join(request.directory, "events.jsonl");
	try {
		const events = readEvents(request);
		const line = `${JSON.stringify(event)}\n`;
		if (events.length >= MAX_EVENTS || statSync(log).size + Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new Error("trusted agy event log bound exhausted");
		appendFileSync(log, line, { mode: 0o600 });
		chmodSync(log, 0o600);
	} catch (error) {
		// ponytail: one terminal marker prevents a cap/failing append from leaving a success certificate.
		writeFileSync(path.join(request.directory, "incomplete"), "event log is incomplete\n", { mode: 0o600 });
		throw error;
	}
}

export function createAgyRequest(baseDirectory: string, input: AgyRequestInput): AgyRequest {
	if (Buffer.byteLength(input.task, "utf8") > AGY_TOOL_LIMITS.taskBytes) throw new Error("agy task excerpt exceeds 4 KiB");
	const id = randomUUID();
	const directory = path.join(baseDirectory, id);
	mkdirSync(directory, { recursive: false, mode: 0o700 });
	chmodSync(directory, 0o700);
	const stored: StoredRequest = {
		...input,
		id,
		task: input.task,
		taskDigest: createHash("sha256").update(input.task).digest("hex"),
	};
	const requestPath = path.join(directory, "request.json");
	writeFileSync(requestPath, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
	chmodSync(requestPath, 0o600);
	writeFileSync(path.join(directory, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
	return { id, directory, requestPath };
}

interface HookEventContext {
	requestData: StoredRequest;
	events: StoredEvent[];
	conversationId: string;
}

function readHookEventContext(request: AgyRequest, input: AgyHookEvent): HookEventContext | undefined {
	const stored = safeJson(request.requestPath);
	if (!stored) return undefined;
	let events: StoredEvent[];
	try { events = readEvents(request); } catch { return undefined; }
	const conversationId = input.conversationId;
	if (typeof conversationId !== "string" || !conversationId) return undefined;
	// SAFETY: createAgyRequest writes this exact immutable schema with mode 0600.
	const requestData = stored as unknown as StoredRequest;
	if (input.modelName !== requestData.model || !Array.isArray(input.workspacePaths) || input.workspacePaths.length !== 1 || input.workspacePaths[0] !== requestData.workspace) return undefined;
	return { requestData, events, conversationId };
}

function bindHookConversation(request: AgyRequest, input: AgyHookEvent, context: HookEventContext): boolean {
	const bindingPath = path.join(request.directory, "binding.json");
	const binding = safeJson(bindingPath);
	if (binding && binding.conversationId !== context.conversationId) return false;
	const priorTranscript = context.events.find((item) => item.event === "PreInvocation")?.transcriptPath;
	if (typeof input.transcriptPath === "string" && priorTranscript && priorTranscript !== input.transcriptPath) return false;
	if (!binding) {
		try {
			writeFileSync(bindingPath, JSON.stringify({ conversationId: context.conversationId }), { flag: "wx", mode: 0o600 });
			chmodSync(bindingPath, 0o600);
		} catch { return false; }
	}
	return true;
}

function bindHookEvent(request: AgyRequest, input: AgyHookEvent): HookEventContext | undefined {
	const context = readHookEventContext(request, input);
	if (!context || !bindHookConversation(request, input, context)) return undefined;
	return context;
}

function recordPreInvocation(request: AgyRequest, input: AgyHookEvent, context: HookEventContext): boolean {
	writeEvent(request, { event: "PreInvocation", conversationId: context.conversationId, transcriptPath: typeof input.transcriptPath === "string" ? input.transcriptPath : undefined });
	return true;
}

function recordPreToolUse(request: AgyRequest, input: AgyHookEvent, context: HookEventContext): boolean {
	const call = input.toolCall;
	if (!call || typeof call.name !== "string" || !Number.isSafeInteger(input.stepIdx)) return false;
	const argsDigest = digestAgyArguments(call.args);
	if (context.events.some((item) => item.stepIdx === input.stepIdx)) return false;
	const args = typeof call.args === "object" && call.args !== null && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
	const challengeTarget = context.requestData.challenge === true && call.name === "view_file" && typeof args.AbsolutePath === "string" ? args.AbsolutePath : undefined;
	writeEvent(request, { event: "PreToolUse", conversationId: context.conversationId, stepIdx: input.stepIdx as number, name: call.name, argsDigest, status: "pending", challengeTarget });
	return true;
}

function recordPostToolUse(request: AgyRequest, input: AgyHookEvent, context: HookEventContext): boolean {
	if (!Number.isSafeInteger(input.stepIdx)) return false;
	const prior = context.events.find((item) => item.stepIdx === input.stepIdx && item.status === "pending");
	if (!prior) return false;
	writeEvent(request, { event: "PostToolUse", conversationId: context.conversationId, stepIdx: input.stepIdx as number, name: prior.name, argsDigest: prior.argsDigest, status: input.error ? "error" : "complete" });
	return true;
}

function recordHealthyStop(request: AgyRequest, input: AgyHookEvent, context: HookEventContext): boolean {
	const calls = context.events.filter((item) => item.event === "PreToolUse");
	const unresolved = calls.some((call) => {
		const decision = context.events.find((item) => item.event === "AgyDecision" && item.stepIdx === call.stepIdx);
		if (!decision || decision.degraded) return true;
		if (decision.status === "denied") return false;
		return !context.events.some((item) => item.event === "PostToolUse" && item.stepIdx === call.stepIdx && item.status === "complete");
	});
	const healthy = input.terminationReason === "model_stop" && input.fullyIdle === true && !input.error && !unresolved && !context.events.some((item) => item.status === "error");
	// ponytail: a continued Stop is not a terminal record; only commit verified completion.
	if (!healthy) return false;
	writeEvent(request, { event: "Stop", conversationId: context.conversationId, healthy: true });
	return true;
}

export function recordAgyHookEvent(request: AgyRequest, input: AgyHookEvent): boolean {
	const context = bindHookEvent(request, input);
	if (!context) return false;
	switch (input.event) {
		case "PreInvocation": return recordPreInvocation(request, input, context);
		case "PreToolUse": return recordPreToolUse(request, input, context);
		case "PostToolUse": return recordPostToolUse(request, input, context);
		case "Stop": return recordHealthyStop(request, input, context);
		default: return false;
	}
}

export function countAgyJudgments(request: AgyRequest): number {
	try {
		return readEvents(request).filter((event) => event.event === "AgyDecision" && event.judged === true).length;
	} catch {
		return AGY_TOOL_LIMITS.judgments;
	}
}

export function reserveAgyJudgment(request: AgyRequest): number | undefined {
	// ponytail: exclusive slot files enforce the cap across hook processes without a lock.
	for (let slot = countAgyJudgments(request); slot < AGY_TOOL_LIMITS.judgments; slot += 1) {
		try {
			writeFileSync(path.join(request.directory, `judgment-${slot}.reserved`), "", { flag: "wx", mode: 0o600 });
			return slot;
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
		}
	}
	return undefined;
}

/** A degraded or unreadable request must deny subsequent inspection without another judgment. */
export function hasAgyDegradedDecision(request: AgyRequest): boolean {
	try { return readEvents(request).some((event) => event.degraded === true); }
	catch { return true; }
}

export function recordAgyToolDecision(request: AgyRequest, stepIdx: number, allowed: boolean, degraded: boolean, judged = true): void {
	let events: StoredEvent[];
	try {
		events = readEvents(request);
	} catch {
		throw new Error("cannot read trusted agy hook event log");
	}
	const pending = events.find((event) => event.event === "PreToolUse" && event.stepIdx === stepIdx && event.status === "pending");
	if (!pending || events.some((event) => event.event === "AgyDecision" && event.stepIdx === stepIdx)) throw new Error("tool decision has no unique pending trusted hook record");
	writeEvent(request, { event: "AgyDecision", conversationId: pending.conversationId, stepIdx, name: pending.name, argsDigest: pending.argsDigest, status: allowed ? "allowed" : "denied", degraded, judged });
}

export function verifyAgyChallenge(request: AgyRequest, conversationId: string, fixturePath: string): boolean {
	const lifecycle = verifyAgyLifecycle(request);
	if (!lifecycle.healthy) return false;
	const events = lifecycle.events as StoredEvent[];
	const calls = events.filter((event) => event.event === "PreToolUse");
	if (calls.length !== 1 || calls[0]?.name !== "view_file" || calls[0]?.challengeTarget !== fixturePath) return false;
	const stepIdx = calls[0]?.stepIdx;
	const decision = events.find((event) => event.event === "AgyDecision" && event.stepIdx === stepIdx);
	const stop = events.find((event) => event.event === "Stop");
	return calls[0]?.conversationId === conversationId && decision?.status === "denied" && decision.degraded !== true && stop?.healthy === true;
}

export function getAgyTranscriptPath(request: AgyRequest): string | undefined {
	const lifecycle = verifyAgyLifecycle(request);
	if (!lifecycle.healthy) return undefined;
	const events = lifecycle.events as StoredEvent[];
	const paths = [...new Set(events.filter((event) => event.event === "PreInvocation").map((event) => event.transcriptPath).filter((value): value is string => typeof value === "string"))];
	return paths.length === 1 ? paths[0] : undefined;
}

export function verifyAgyLifecycle(request: AgyRequest): { healthy: boolean; events: unknown[] } {
	let events: StoredEvent[];
	try { events = readEvents(request); }
	catch { return { healthy: false, events: [] }; }
	const binding = safeJson(path.join(request.directory, "binding.json"));
	const typed = events as StoredEvent[];
	const stop = typed.filter((event) => event.event === "Stop");
	const steps = new Map<number, StoredEvent>();
	for (const event of typed) {
		if (typeof event.stepIdx !== "number") continue;
		if (event.event === "PreToolUse") {
			if (steps.has(event.stepIdx) || event.status !== "pending") return { healthy: false, events };
			steps.set(event.stepIdx, event);
		} else if (event.event === "AgyDecision") {
			const pending = steps.get(event.stepIdx);
			if (!pending || pending.status !== "pending" || event.status === undefined || (event.status !== "allowed" && event.status !== "denied")) return { healthy: false, events };
			if (event.status === "denied") steps.delete(event.stepIdx);
			else steps.set(event.stepIdx, event);
		} else if (event.event === "PostToolUse") {
			const decision = steps.get(event.stepIdx);
			if (!decision || decision.status !== "allowed" || (event.status !== "complete" && event.status !== "error")) return { healthy: false, events };
			steps.delete(event.stepIdx);
		}
	}
	return {
		healthy: typeof binding?.conversationId === "string" && stop.length === 1 && stop[0]?.healthy === true && steps.size === 0 && !typed.some((event) => event.status === "error" || event.degraded === true),
		events,
	};
}
