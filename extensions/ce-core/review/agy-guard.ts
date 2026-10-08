import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import path from "node:path";
import { createJevRuntime } from "../jev/runtime";
import { classifyAgyToolCall, judgeAgyRelevance } from "./agy-policy";
import { hasAgyDegradedDecision, recordAgyHookEvent, recordAgyToolDecision, reserveAgyJudgment, verifyAgyLifecycle, type AgyHookEvent, type AgyRequest } from "./agy-state";

const MAX_INPUT_BYTES = 16 * 1024;

function requestFromEnvironment(env: NodeJS.ProcessEnv): AgyRequest | undefined {
	const requestPath = env.PEDSTACK_AGY_REQUEST;
	const token = env.PEDSTACK_AGY_TOKEN;
	if (!requestPath || !token || path.basename(path.dirname(requestPath)) !== token) return undefined;
	const directory = path.dirname(requestPath);
	return { id: token, directory, requestPath };
}

function output(value: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(value));
}

function malformedMarkerOutput(eventName?: string): Record<string, unknown> {
	if (eventName === "PreToolUse") return { decision: "deny", reason: "pi-pedstack guard launch marker is malformed" };
	if (eventName === "Stop") return { decision: "continue", reason: "pi-pedstack guard launch marker is malformed" };
	return {};
}

function failedValidationOutput(eventName?: string): Record<string, unknown> {
	if (eventName === "PreToolUse") return { decision: "deny", reason: "pi-pedstack guard failed closed while validating this tool" };
	if (eventName === "Stop") return { decision: "continue", reason: "pi-pedstack guard could not verify review completion" };
	return {};
}

type AgyRequestData = { model: string; workspace: string; task: string; challenge?: boolean };

function parseHookEvent(raw: string | Buffer, eventName?: string): AgyHookEvent | undefined {
	const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
	if (bytes.byteLength > MAX_INPUT_BYTES) {
		output({ decision: "deny", reason: "pi-pedstack guard input exceeds its safety limit" });
		return undefined;
	}
	let decoded: string;
	try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
		output({ decision: "deny", reason: "pi-pedstack guard input is not valid UTF-8" });
		return undefined;
	}
	let input: unknown;
	try { input = JSON.parse(decoded) as unknown; } catch {
		output({ decision: "deny", reason: "pi-pedstack guard could not parse hook input" });
		return undefined;
	}
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		output({ decision: "deny", reason: "pi-pedstack guard received an invalid hook event" });
		return undefined;
	}
	return { ...(input as AgyHookEvent), event: eventName } as AgyHookEvent;
}

async function handlePreToolUse(request: AgyRequest, event: AgyHookEvent, requestData: AgyRequestData, env: NodeJS.ProcessEnv): Promise<void> {
	if (!recordAgyHookEvent(request, { ...event, event: "PreToolUse" })) {
		output({ decision: "deny", reason: "pi-pedstack guard could not bind this tool call" });
		return;
	}
	if (hasAgyDegradedDecision(request)) {
		recordAgyToolDecision(request, event.stepIdx as number, false, true, false);
		output({ decision: "deny", reason: "pi-pedstack guard request already has a degraded decision" });
		return;
	}
	if (requestData.challenge === true) {
		recordAgyToolDecision(request, event.stepIdx as number, false, false, false);
		output({ decision: "deny", reason: "pi-pedstack guard challenge denies all inspection" });
		return;
	}
	const result = classifyAgyToolCall(event.toolCall?.name, event.toolCall?.args, requestData.workspace);
	if (!result.allowed) {
		recordAgyToolDecision(request, event.stepIdx as number, false, false, false);
		output({ decision: "deny", reason: result.reason });
		return;
	}
	const jevCommand = env.PEDSTACK_AGY_JEV_COMMAND;
	if (!jevCommand || !path.isAbsolute(jevCommand)) {
		recordAgyToolDecision(request, event.stepIdx as number, false, true, false);
		output({ decision: "deny", reason: "pi-pedstack guard has no verified JEV executable" });
		return;
	}
	const judgmentCount = reserveAgyJudgment(request);
	if (judgmentCount === undefined) {
		recordAgyToolDecision(request, event.stepIdx as number, false, true, false);
		output({ decision: "deny", reason: "review judgment budget exhausted" });
		return;
	}
	const semantic = await judgeAgyRelevance(createJevRuntime({ command: jevCommand, timeoutMs: 8000 }), requestData.task, event.toolCall?.name, event.toolCall?.args, requestData.workspace, judgmentCount);
	const degraded = semantic.reason.includes("failed") || semantic.reason.includes("invalid") || semantic.reason.includes("budget") || semantic.reason.includes("exceed");
	recordAgyToolDecision(request, event.stepIdx as number, semantic.allowed, degraded);
	output(semantic.allowed ? { decision: "allow", reason: semantic.reason } : { decision: "deny", reason: semantic.reason });
}

function handleLifecycleEvent(request: AgyRequest, event: AgyHookEvent): void {
	if (!recordAgyHookEvent(request, event)) {
		output(event.event === "Stop" ? { decision: "continue", reason: "pi-pedstack guard lifecycle is incomplete" } : {});
		return;
	}
	if (event.event !== "Stop") { output({}); return; }
	if (!verifyAgyLifecycle(request).healthy) {
		output({ decision: "continue", reason: "pi-pedstack guard could not verify a complete read-only review lifecycle" });
		return;
	}
	output({ decision: "stop" }); // Native contract: any non-continue decision permits Stop.
}

async function handleValidatedHook(request: AgyRequest, event: AgyHookEvent, env: NodeJS.ProcessEnv): Promise<void> {
	try {
		const requestData = JSON.parse(readFileSync(request.requestPath, "utf8")) as AgyRequestData;
		if (event.event === "PreToolUse") await handlePreToolUse(request, event, requestData, env);
		else handleLifecycleEvent(request, event);
	} catch {
		output(failedValidationOutput(event.event));
	}
}

export async function handleAgyHook(raw: string | Buffer, env: NodeJS.ProcessEnv = process.env, eventName?: string): Promise<void> {
	const marked = env.PEDSTACK_AGY_REQUEST !== undefined || env.PEDSTACK_AGY_TOKEN !== undefined;
	if (!marked) return;
	const request = requestFromEnvironment(env);
	if (!request) {
		output(malformedMarkerOutput(eventName));
		return;
	}
	const event = parseHookEvent(raw, eventName);
	if (event) await handleValidatedHook(request, event, env);
}

if (import.meta.main) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const part = bytes.subarray(0, MAX_INPUT_BYTES + 1 - size);
		chunks.push(part);
		size += part.byteLength;
		if (size > MAX_INPUT_BYTES) break;
	}
	await handleAgyHook(Buffer.concat(chunks, size), process.env, process.argv[2]);
}
