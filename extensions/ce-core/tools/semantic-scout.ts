// `semantic_scout` — model-facing tool (plan Unit 5). A thin wrapper over the
// shared `scoutSemanticFiles` engine: many files/dirs/globs, one bounded
// question, typed per-path answers, never a file body.
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	readPiPedstackConfig,
	resolveSemanticReadConfig,
} from "../utils/config-types";
import {
	SEMANTIC_DEGRADED_GUIDANCE,
	scoutSemanticFiles,
	type ScoutRecommendation,
	type ScoutResultEntry,
	type ScoutSemanticFilesResult,
	type SemanticQuestionType,
} from "../utils/semantic-file-ask";
import { describeSemanticAnswer } from "./semantic-read";

interface SemanticScoutToolInput {
	repoRoot: string;
	targets: string[];
	question: string;
	type?: SemanticQuestionType;
	criteria?: unknown;
	select?: boolean;
	limit?: number;
}

interface SemanticScoutToolResult {
	text: string;
	result: ScoutSemanticFilesResult;
}

export interface SemanticScoutDeps {
	jev?: JevRuntime;
	/** Built lazily on first execute so importing this module never spawns a process. */
	jevFactory?: () => JevRuntime;
}

/** Pure rendering of one per-path result entry. */
function formatScoutEntry(entry: ScoutResultEntry): string {
	if (entry.reason === null) return `- ${entry.path}: ${describeSemanticAnswer(entry.answer)}`;
	return `- ${entry.path}: ${entry.reason}`;
}

function formatScoutRecommendation(recommendation: ScoutRecommendation): string {
	return `recommendation: ${recommendation.path} (source=${recommendation.source}, confidence=${recommendation.confidence.toFixed(3)})`;
}

/** Early-return text for the empty and error terminal statuses. */
function formatScoutEmptyOrError(result: ScoutSemanticFilesResult): string | undefined {
	if (result.status === "empty") {
		return result.message ?? "No eligible files matched the provided targets.";
	}
	if (result.status === "error") {
		const detail = result.message ? ` — ${result.message}` : "";
		return `semantic_scout error: ${result.reason ?? "jev_error"}${detail}`;
	}
	return undefined;
}

/** Pure text formatter for the model-facing tool result. */
function formatSemanticScoutText(result: ScoutSemanticFilesResult): string {
	const terminal = formatScoutEmptyOrError(result);
	if (terminal !== undefined) return terminal;

	const lines: string[] = [
		`status: ${result.status}`,
		`counts: totalFound=${result.counts.totalFound} eligible=${result.counts.eligible} returned=${result.counts.returned} omitted=${result.counts.omitted} answered=${result.counts.answered} failed=${result.counts.failed}`,
		`savings: totalFileBytes=${result.savings.totalFileBytes} totalExcerptBytes=${result.savings.totalExcerptBytes} savedBytes=${result.savings.savedBytes}`,
	];
	if (result.timedOut) lines.push("timedOut: true");
	if (result.recommendation) lines.push(formatScoutRecommendation(result.recommendation));
	for (const entry of result.results) lines.push(formatScoutEntry(entry));
	lines.push("(typed answers only — never file bodies)");
	if (result.status === "degraded") {
		lines.push(result.guidance ?? SEMANTIC_DEGRADED_GUIDANCE);
	}
	return lines.join("\n");
}

export function createSemanticScoutTool(deps: SemanticScoutDeps = {}) {
	let cachedJev: JevRuntime | null = deps.jev ?? null;

	const getJev = (): JevRuntime => {
		if (cachedJev) return cachedJev;
		cachedJev = deps.jevFactory ? deps.jevFactory() : createJevRuntime();
		return cachedJev;
	};

	return {
		name: "semantic_scout",
		description:
			"Answer one bounded semantic question across many repo files/dirs/globs and return typed per-path answers with counts, savings, and an optional recommendation. Results are typed answers, never file bodies. Use semantic_scout to decide which file to open next; use `read` for exact text or editing and `grep`/the code graph for deterministic facts. If Jev is unavailable it degrades to explicit `read`/`grep` guidance.",
		async execute(input: SemanticScoutToolInput): Promise<SemanticScoutToolResult> {
			const config = await readPiPedstackConfig(input.repoRoot);
			const budgets = resolveSemanticReadConfig(config);
			const result = await scoutSemanticFiles({
				repoRoot: input.repoRoot,
				targets: input.targets,
				question: input.question,
				type: input.type,
				criteria: input.criteria,
				select: input.select,
				limit: input.limit,
				budgets,
				jev: getJev(),
			});
			return { text: formatSemanticScoutText(result), result };
		},
	};
}
