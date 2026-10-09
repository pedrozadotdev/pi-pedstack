import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { JevRuntimeOptions } from "./jev/types";

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

const FEATURES = new Set<DiagnosticFeature>([
	"workflow", "jev", "stage_gate", "routing", "review", "tool",
	"model", "verification", "solution_search", "semantic_files",
	"docs_verification", "handoff_readiness", "drift", "compaction",
	"injection_screen", "failure_triage", "shell_guard", "unknown",
]);
const OUTCOMES = new Set<DiagnosticOutcome>([
	"success", "failure", "interrupted", "unknown",
]);
const STAGES = new Set([
	"01-brainstorm", "02-plan", "03-work", "04-review", "04-5-debug",
	"05-learn", "06-docsync", "unknown",
]);
const ROLES = new Set(["default", "review", "sota", "override", "unknown"]);
const NUMERIC_FIELDS = [
	"durationMs", "processDurationMs", "providerResponseMs", "providerRequests", "modelCalls", "independentReviewers",
	"repeatAttempt", "inputTokens", "outputTokens", "exitCode", "costUsd",
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

	async function write(record: DiagnosticRecord): Promise<void> {
		if (!enabled || !file) return;
		const safe: Record<string, string | number | boolean | null> = {
			timestamp: new Date(now()).toISOString(),
			runId,
			feature: FEATURES.has(record.feature) ? record.feature : "unknown",
			event: record.event.slice(0, 64).replace(/[^a-z0-9_.-]/gi, "_"),
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

	return {
		enabled: (): boolean => enabled,
		record: write,
		async startStage(stage: string): Promise<{ episodeId: string; attempt: number }> {
			const normalized = STAGES.has(stage) ? stage : "unknown";
			for (const [id, episode] of episodes) {
				await write({ feature: "workflow", event: "stage_interrupted", stage: episode.stage, outcome: "interrupted", durationMs: now() - episode.startedAt, episodeId: id });
				episodes.delete(id);
			}
			const attempt = (repeats.get(normalized) ?? 0) + 1;
			repeats.set(normalized, attempt);
			const episodeId = randomUUID();
			episodes.set(episodeId, { stage: normalized, startedAt: now() });
			await write({ feature: "workflow", event: "stage_start", stage: normalized, repeatAttempt: attempt, episodeId });
			return { episodeId, attempt };
		},
		async endStage(episodeId: string, outcome: DiagnosticOutcome): Promise<void> {
			const episode = episodes.get(episodeId);
			if (!episode) return;
			episodes.delete(episodeId);
			await write({ feature: "workflow", event: "stage_end", stage: episode.stage, outcome, durationMs: now() - episode.startedAt, stageTransitions: outcome === "success" ? 1 : 0, episodeId });
		},
		resetAttempts(): void {
			repeats.clear();
		},
		async shutdown(): Promise<void> {
			for (const [id, episode] of episodes) {
				await write({ feature: "workflow", event: "stage_interrupted", stage: episode.stage, outcome: "interrupted", durationMs: now() - episode.startedAt, episodeId: id });
			}
			episodes.clear();
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

export function recordSolutionSearch(stage: string | null, query: unknown): void {
	let repeated = false;
	if (typeof query === "string" && Buffer.byteLength(query, "utf8") <= 8192) {
		const fingerprint = createHash("sha256").update(query).digest("hex").slice(0, 16);
		repeated = searchFingerprints.has(fingerprint);
		if (searchFingerprints.size < 256) searchFingerprints.add(fingerprint);
	}
	recordDiagnostic({ feature: "solution_search", event: "search_invocation", stage: stage ?? "unknown", searchCalls: 1, repeatSearches: repeated ? 1 : 0 });
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

export async function endDiagnosticStage(outcome: DiagnosticOutcome): Promise<void> {
	if (!activeEpisode) return;
	await currentDiagnostics().endStage(activeEpisode, outcome);
	activeEpisode = undefined;
}

export async function shutdownDiagnostics(): Promise<void> {
	await endDiagnosticStage("interrupted");
	await currentDiagnostics().shutdown();
	activeRole = "unknown";
}

export async function resetDiagnosticWorkflow(): Promise<void> {
	await endDiagnosticStage("interrupted");
	currentDiagnostics().resetAttempts();
	activeRole = "unknown";
	searchFingerprints.clear();
}
