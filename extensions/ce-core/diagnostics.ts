import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { JevRuntimeOptions } from "./jev/types";
import { classifyVerificationCommand } from "./tools/bash-output-filter";

export const DIAGNOSTICS_FILE_ENV = "PEDSTACK_DIAGNOSTICS_FILE";

export type DiagnosticFeature =
	| "workflow"
	| "jev"
	| "stage_gate"
	| "routing"
	| "review"
	| "tool"
	| "model"
	| "verification"
	| "solution_search"
	| "semantic_files"
	| "docs_verification"
	| "handoff_readiness"
	| "drift"
	| "compaction"
	| "injection_screen"
	| "failure_triage"
	| "shell_guard"
	| "unknown";

export type DiagnosticOutcome =
	| "success"
	| "failure"
	| "interrupted"
	| "unknown";

export interface DiagnosticRecord {
	feature: DiagnosticFeature;
	stage?: string;
	role?: "default" | "review" | "sota" | "override" | "unknown";
	event: string;
	outcome?: DiagnosticOutcome;
	durationMs?: number;
	processDurationMs?: number;
	providerResponseMs?: number;
	processInvoked?: boolean;
	providerRequests?: number;
	searchCalls?: number;
	repeatSearches?: number;
	stageTransitions?: number;
	modelCalls?: number;
	independentReviewers?: number;
	repeatAttempt?: number;
	reviewFindings?: number;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	/** Null means the runtime did not expose usage. */
	usageKnown?: boolean;
	exitCode?: number;
	/** Run-local opaque identifier. Never use a session, prompt, or repo path. */
	runId?: string;
	/** Opaque ID linking events inside the current process only. */
	episodeId?: string;
}

/** Return a fixed category for verification commands without retaining command text. */
export function isDiagnosticVerificationCall(toolName: string, args: unknown): boolean {
	if (toolName !== "bash" || !args || typeof args !== "object") return false;
	const command = (args as Record<string, unknown>).command;
	return typeof command === "string" && classifyVerificationCommand(command) !== null;
}

const FEATURES = new Set<DiagnosticFeature>([
	"workflow", "jev", "stage_gate", "routing", "review", "tool",
	"model", "verification", "solution_search", "semantic_files",
	"docs_verification", "handoff_readiness", "drift", "compaction",
	"injection_screen", "failure_triage", "shell_guard", "unknown",
]);
const OUTCOMES = new Set<DiagnosticOutcome>([
	"success", "failure", "interrupted", "unknown",
]);
const EVENTS = new Set([
	"stage_start", "stage_end", "stage_interrupted", "handoff_saved", "workflow_complete",
	"stage_transition",
	"jev_decision", "role_selected", "review_attempt", "review_skipped", "review_outcome", "tool_execution",
	"verification_execution", "search_invocation", "automatic_search", "model_response",
	"provider_request", "provider_response",
]);
const STAGES = new Set([
	"01-brainstorm", "02-plan", "03-work", "04-review", "04-5-debug",
	"05-learn", "06-docsync", "unknown",
]);
const ROLES = new Set(["default", "review", "sota", "override", "unknown"]);
const NUMERIC_FIELDS = [
	"durationMs", "processDurationMs", "providerResponseMs", "providerRequests", "modelCalls", "independentReviewers",
	"repeatAttempt", "reviewFindings", "inputTokens", "outputTokens", "exitCode", "costUsd",
	"searchCalls", "repeatSearches", "stageTransitions",
] as const;

export function createDiagnostics(options: {
	file?: string;
	now?: () => number;
	runId?: string;
} = {}) {
	const file = options.file ?? process.env[DIAGNOSTICS_FILE_ENV];
	const now = options.now ?? (() => Date.now());
	const runId = options.runId ?? randomUUID();
	let enabled = typeof file === "string" && path.isAbsolute(file);
	let warned = false;
	const episodes = new Map<string, { stage: string; startedAt: number }>();
	const repeats = new Map<string, number>();
	let pendingHandoff: { currentStage: string; nextStage: string } | undefined;
	let writeTail: Promise<void> = Promise.resolve();
	let queuedWrites = 0;
	const maxQueuedWrites = 4096;

	async function write(record: DiagnosticRecord): Promise<void> {
		if (!enabled || !file) return;
		const safe: Record<string, string | number | boolean | null> = {
			timestamp: new Date(now()).toISOString(),
			runId,
			feature: FEATURES.has(record.feature) ? record.feature : "unknown",
		event: EVENTS.has(record.event) ? record.event : "unknown",
		};
		if (record.stage !== undefined) safe.stage = STAGES.has(record.stage) ? record.stage : "unknown";
		if (record.role !== undefined) safe.role = ROLES.has(record.role) ? record.role : "unknown";
		if (record.outcome !== undefined) safe.outcome = OUTCOMES.has(record.outcome) ? record.outcome : "unknown";
		for (const field of NUMERIC_FIELDS) {
			const value = record[field];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[field] = value;
		}
		if (typeof record.processInvoked === "boolean") safe.processInvoked = record.processInvoked;
		if (typeof record.usageKnown === "boolean") safe.usageKnown = record.usageKnown;
		if (record.episodeId) safe.episodeId = record.episodeId;
		try {
			await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			await appendFile(file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {
			enabled = false;
			if (!warned) {
				warned = true;
				process.emitWarning("[pi-pedstack] local diagnostics disabled after a file write error");
			}
		}
	}

	function enqueue(record: DiagnosticRecord): Promise<void> {
		if (!enabled || !file) return Promise.resolve();
		if (queuedWrites >= maxQueuedWrites) {
			if (!warned) {
				warned = true;
				process.emitWarning("[pi-pedstack] local diagnostics dropped a record because the write queue filled");
			}
			return Promise.resolve();
		}
		queuedWrites++;
		const pending = writeTail.then(() => write(record));
		writeTail = pending.catch(() => undefined).then(() => { queuedWrites--; });
		return pending;
	}

	return {
		enabled: (): boolean => enabled,
		record: enqueue,
		async startStage(stage: string): Promise<{ episodeId: string; attempt: number }> {
			const normalized = STAGES.has(stage) ? stage : "unknown";
			const transitionAccepted = pendingHandoff?.nextStage === normalized;
			for (const [id, episode] of episodes) {
				if (transitionAccepted && pendingHandoff?.currentStage === episode.stage) {
					await this.endStage(id, "success");
				} else {
					await enqueue({ feature: "workflow", event: "stage_interrupted", stage: episode.stage, outcome: "interrupted", durationMs: now() - episode.startedAt, episodeId: id });
				}
				episodes.delete(id);
			}
			pendingHandoff = undefined;
			const attempt = (repeats.get(normalized) ?? 0) + 1;
			repeats.set(normalized, attempt);
			const episodeId = randomUUID();
			episodes.set(episodeId, { stage: normalized, startedAt: now() });
			await enqueue({ feature: "workflow", event: "stage_start", stage: normalized, repeatAttempt: attempt, episodeId });
			if (transitionAccepted) {
				await enqueue({ feature: "workflow", event: "stage_transition", stage: normalized, stageTransitions: 1 });
			}
			return { episodeId, attempt };
		},
		async endStage(episodeId: string, outcome: DiagnosticOutcome): Promise<void> {
			const episode = episodes.get(episodeId);
			if (!episode) return;
			episodes.delete(episodeId);
			await enqueue({ feature: "workflow", event: "stage_end", stage: episode.stage, outcome, durationMs: now() - episode.startedAt, stageTransitions: 0, episodeId });
		},
		async handoff(currentStage: string, nextStage: string): Promise<void> {
			const currentEpisode = [...episodes].find(([, episode]) => episode.stage === currentStage);
			pendingHandoff = currentEpisode ? { currentStage, nextStage } : undefined;
			if (currentEpisode) await this.endStage(currentEpisode[0], "success");
			await enqueue({ feature: "workflow", event: "handoff_saved", stage: currentStage, outcome: "success" });
		},
		async completeWorkflow(stage: string): Promise<void> {
			for (const [id, episode] of episodes) {
				await this.endStage(id, episode.stage === stage ? "success" : "interrupted");
			}
			episodes.clear();
			pendingHandoff = undefined;
			await enqueue({ feature: "workflow", event: "workflow_complete", stage, outcome: "success" });
		},
		resetAttempts(): void {
			repeats.clear();
		},
		async shutdown(preservePendingHandoff = false): Promise<void> {
			for (const [id, episode] of episodes) {
				await enqueue({ feature: "workflow", event: "stage_interrupted", stage: episode.stage, outcome: "interrupted", durationMs: now() - episode.startedAt, stageTransitions: 0, episodeId: id });
			}
			episodes.clear();
			if (!preservePendingHandoff) pendingHandoff = undefined;
			await writeTail;
		},
	};
}

let shared: ReturnType<typeof createDiagnostics> | undefined;
let activeEpisode: string | undefined;
let activeRole: DiagnosticRecord["role"] = "unknown";
const searchFingerprints = new Set<string>();

function currentDiagnostics() {
	shared ??= createDiagnostics();
	return shared;
}

export function recordDiagnostic(record: DiagnosticRecord): void {
	void currentDiagnostics().record(record);
}

export function setDiagnosticRole(role: DiagnosticRecord["role"]): void {
	activeRole = role ?? "unknown";
}

export function getDiagnosticRole(): DiagnosticRecord["role"] {
	return activeRole;
}

export function recordSolutionSearch(stage: string | null, query: unknown, source: "manual" | "automatic" = "manual"): DiagnosticRecord {
	let repeated = false;
	if (typeof query === "string" && Buffer.byteLength(query, "utf8") <= 8192) {
		const fingerprint = createHash("sha256").update(query).digest("hex").slice(0, 16);
		repeated = searchFingerprints.has(fingerprint);
		if (searchFingerprints.size < 256) searchFingerprints.add(fingerprint);
	}
	const record: DiagnosticRecord = { feature: "solution_search", event: source === "automatic" ? "automatic_search" : "search_invocation", stage: stage ?? "unknown", searchCalls: 1, repeatSearches: repeated ? 1 : 0 };
	recordDiagnostic(record);
	return record;
}

export function diagnosticJevOptions(
	feature: DiagnosticFeature,
	stage: () => string | null = () => null,
): Pick<JevRuntimeOptions, "feature" | "telemetry"> {
	return {
		feature,
		telemetry(event) {
			recordDiagnostic({
				feature,
				event: "jev_decision",
				stage: stage() ?? "unknown",
				outcome: event.outcome,
				durationMs: event.durationMs,
				processDurationMs: event.processDurationMs,
				processInvoked: event.processInvoked,
				usageKnown: event.usage !== undefined,
				exitCode: event.exitCode,
				...(event.usage ? { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens } : {}),
			});
		},
	};
}

export async function startDiagnosticStage(stage: string): Promise<void> {
	activeRole = "unknown";
	const result = await currentDiagnostics().startStage(stage);
	activeEpisode = result.episodeId;
}

export function recordDiagnosticHandoff(currentStage: string, nextStage: string): void {
	void currentDiagnostics().handoff(currentStage, nextStage);
}

export async function completeDiagnosticWorkflow(stage: string): Promise<void> {
	await currentDiagnostics().completeWorkflow(stage);
	activeEpisode = undefined;
}

export async function endDiagnosticStage(outcome: DiagnosticOutcome): Promise<void> {
	if (!activeEpisode) return;
	await currentDiagnostics().endStage(activeEpisode, outcome);
	activeEpisode = undefined;
}

export async function shutdownDiagnostics(preservePendingHandoff = false): Promise<void> {
	await endDiagnosticStage("interrupted");
	await currentDiagnostics().shutdown(preservePendingHandoff);
	activeRole = "unknown";
}

export async function resetDiagnosticWorkflow(): Promise<void> {
	await endDiagnosticStage("interrupted");
	currentDiagnostics().resetAttempts();
	activeRole = "unknown";
	searchFingerprints.clear();
}

/** @internal Isolates singleton-backed diagnostics tests. */
export async function __resetDiagnosticsForTests(): Promise<void> {
	if (shared) await shared.shutdown();
	shared = undefined;
	activeEpisode = undefined;
	activeRole = "unknown";
	searchFingerprints.clear();
}
