import { readFile } from "node:fs/promises";
import path from "node:path";

interface Row {
	feature?: string;
	stage?: string;
	event?: string;
	outcome?: string;
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
	usageKnown?: boolean;
	role?: string;
	exitCode?: number;
}

const FEATURES = new Set([
	"workflow", "jev", "stage_gate", "routing", "review", "tool", "model",
	"verification", "solution_search", "semantic_files", "docs_verification",
	"handoff_readiness", "drift", "compaction", "injection_screen",
	"failure_triage", "shell_guard", "unknown",
]);
const STAGES = new Set([
	"01-brainstorm", "02-plan", "03-work", "04-review", "04-5-debug",
	"05-learn", "06-docsync", "unknown",
]);
const ROLES = new Set(["default", "review", "sota", "override", "unknown"]);
const OUTCOMES = new Set(["success", "failure", "interrupted", "unknown"]);
const EVENTS = new Set([
	"stage_start", "stage_end", "stage_interrupted", "handoff_saved", "stage_transition", "workflow_complete",
	"jev_decision", "role_selected", "review_attempt", "review_skipped", "tool_execution",
	"verification_execution", "search_invocation", "automatic_search", "model_response",
	"provider_request", "provider_response", "unknown",
]);

function safeRow(value: unknown): Row {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const row: Row = {};
	if (typeof input.feature === "string" && FEATURES.has(input.feature)) row.feature = input.feature;
	if (typeof input.stage === "string" && STAGES.has(input.stage)) row.stage = input.stage;
	if (typeof input.role === "string" && ROLES.has(input.role)) row.role = input.role;
	if (typeof input.outcome === "string" && OUTCOMES.has(input.outcome)) row.outcome = input.outcome;
	if (typeof input.event === "string" && EVENTS.has(input.event)) row.event = input.event;
	for (const key of ["durationMs", "processDurationMs", "providerResponseMs", "providerRequests", "modelCalls", "independentReviewers", "repeatAttempt", "inputTokens", "outputTokens", "costUsd", "exitCode", "searchCalls", "repeatSearches", "stageTransitions"] as const) {
		const number = input[key];
		if (typeof number === "number" && Number.isFinite(number) && number >= 0) row[key] = number;
	}
	if (typeof input.processInvoked === "boolean") row.processInvoked = input.processInvoked;
	if (typeof input.usageKnown === "boolean") row.usageKnown = input.usageKnown;
	return row;
}

function quantile(values: number[], probability: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(probability * sorted.length) - 1];
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function variance(values: number[]): number | null {
	if (values.length < 2) return null;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

export function summarizeDiagnostics(rows: Row[]) {
	const groups = new Map<string, Row[]>();
	for (const raw of rows) {
		const row = safeRow(raw);
		const key = `${row.stage ?? "unknown"}/${row.feature ?? "unknown"}`;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups].map(([group, entries]) => {
		const durations = entries.flatMap((row) => typeof row.durationMs === "number" ? [row.durationMs] : []);
		const processDurations = entries.flatMap((row) => typeof row.processDurationMs === "number" ? [row.processDurationMs] : []);
		const providerDurations = entries.flatMap((row) => typeof row.providerResponseMs === "number" ? [row.providerResponseMs] : []);
		const usageResponses = entries.filter((row) => row.event === "model_response" || row.event === "jev_decision");
		const knownUsage = usageResponses.filter((row) => row.usageKnown === true);
		const knownCosts = usageResponses.flatMap((row) => typeof row.costUsd === "number" ? [row.costUsd] : []);
		return {
			group,
			observations: entries.length,
			events: Object.fromEntries([...new Set(entries.map((row) => row.event ?? "unknown"))].map((event) => [event, entries.filter((row) => (row.event ?? "unknown") === event).length])),
			roles: Object.fromEntries([...new Set(entries.map((row) => row.role ?? "unknown"))].map((role) => [role, entries.filter((row) => (row.role ?? "unknown") === role).length])),
			durationMs: { median: median(durations), p95: quantile(durations, 0.95), variance: variance(durations) },
			processDurationMs: { median: median(processDurations), p95: quantile(processDurations, 0.95), variance: variance(processDurations) },
			providerResponseMs: { median: median(providerDurations), p95: quantile(providerDurations, 0.95), variance: variance(providerDurations) },
			processInvocations: entries.filter((row) => row.processInvoked === true).length,
			providerRequests: entries.reduce((sum, row) => sum + (row.providerRequests ?? 0), 0),
			processExitCodes: Object.fromEntries([
				...new Set(entries.flatMap((row) => row.processInvoked ? [typeof row.exitCode === "number" ? String(row.exitCode) : "unknown"] : [])),
			].map((code) => [code, entries.filter((row) => row.processInvoked && (typeof row.exitCode === "number" ? row.exitCode === Number(code) : code === "unknown")).length])),
			modelCalls: entries.reduce((sum, row) => sum + (row.modelCalls ?? 0), 0),
			searchCalls: entries.reduce((sum, row) => sum + (row.searchCalls ?? 0), 0),
			repeatSearches: entries.reduce((sum, row) => sum + (row.repeatSearches ?? 0), 0),
			stageTransitions: entries.reduce((sum, row) => sum + (row.stageTransitions ?? 0), 0),
			independentReviewers: entries.reduce((sum, row) => sum + (row.independentReviewers ?? 0), 0),
			repeatAttempts: entries.reduce((sum, row) => sum + ((row.repeatAttempt ?? 1) > 1 ? 1 : 0), 0),
			usage: knownUsage.length === 0 ? "unknown" : {
				knownObservations: knownUsage.length,
				inputTokens: knownUsage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
				outputTokens: knownUsage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
				partial: knownUsage.length !== usageResponses.length,
			},
			costUsd: knownCosts.length === 0 ? "unknown" : {
				knownObservations: knownCosts.length,
				total: knownCosts.reduce((sum, value) => sum + value, 0),
				partial: knownCosts.length !== usageResponses.length,
			},
			outcomes: Object.fromEntries([...new Set(entries.map((row) => row.outcome ?? "unknown"))].map((outcome) => [outcome, entries.filter((row) => (row.outcome ?? "unknown") === outcome).length])),
		};
	});
}

export async function readDiagnosticsReport(file: string): Promise<ReturnType<typeof summarizeDiagnostics>> {
	const content = await readFile(file, "utf8");
	const rows: Row[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			rows.push(safeRow(parsed));
		} catch {
			throw new Error(`Invalid diagnostics JSON on line ${index + 1}`);
		}
	}
	return summarizeDiagnostics(rows);
}

function delta(before: number | null, after: number | null) {
	if (before === null || after === null) return { before, after, deltaMs: null, deltaPercent: null };
	return {
		before,
		after,
		deltaMs: after - before,
		deltaPercent: before === 0 ? null : ((after - before) / before) * 100,
	};
}

export function compareDiagnosticsReports(
	before: Awaited<ReturnType<typeof readDiagnosticsReport>>,
	after: Awaited<ReturnType<typeof readDiagnosticsReport>>,
) {
	const groups = new Map<string, { before?: (typeof before)[number]; after?: (typeof after)[number] }>();
	for (const entry of before) groups.set(entry.group, { before: entry });
	for (const entry of after) groups.set(entry.group, { ...groups.get(entry.group), after: entry });
	return [...groups].map(([group, pair]) => ({
		group,
		durationMs: delta(pair.before?.durationMs.median ?? null, pair.after?.durationMs.median ?? null),
		processDurationMs: delta(pair.before?.processDurationMs.median ?? null, pair.after?.processDurationMs.median ?? null),
		providerResponseMs: delta(pair.before?.providerResponseMs.median ?? null, pair.after?.providerResponseMs.median ?? null),
		beforeCounts: pair.before ? {
			modelCalls: pair.before.modelCalls,
			processInvocations: pair.before.processInvocations,
			independentReviewers: pair.before.independentReviewers,
			repeatAttempts: pair.before.repeatAttempts,
		} : null,
		afterCounts: pair.after ? {
			modelCalls: pair.after.modelCalls,
			processInvocations: pair.after.processInvocations,
			independentReviewers: pair.after.independentReviewers,
			repeatAttempts: pair.after.repeatAttempts,
		} : null,
		beforeUsage: pair.before?.usage ?? "unknown",
		afterUsage: pair.after?.usage ?? "unknown",
		beforeCostUsd: pair.before?.costUsd ?? "unknown",
		afterCostUsd: pair.after?.costUsd ?? "unknown",
	}));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const compareIndex = args.indexOf("--compare");
	const file = args[0];
	const comparisonFile = compareIndex >= 0 ? args[compareIndex + 1] : undefined;
	if (!file || !path.isAbsolute(file) || (compareIndex >= 0 && (!comparisonFile || !path.isAbsolute(comparisonFile)))) {
		process.stderr.write("Usage: bun extensions/ce-core/diagnostics-report.ts <absolute-jsonl-file> [--compare <absolute-jsonl-file>]\n");
		process.exitCode = 2;
	} else {
		try {
			const report = await readDiagnosticsReport(file);
			if (comparisonFile) {
				const comparison = await readDiagnosticsReport(comparisonFile);
				process.stdout.write(`${JSON.stringify(compareDiagnosticsReports(report, comparison), null, 2)}\n`);
			} else {
				process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			}
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : "Unable to read diagnostics"}\n`);
			process.exitCode = 1;
		}
	}
}
