import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	readPiPedstackConfig,
	resolveSolutionRankingConfig,
} from "../utils/config-types";
import {
	formatSolutionMetaLines,
	rankSolutions,
	type SolutionRankingMode,
	type SolutionRankingResult,
} from "../utils/solution-ranking";

/**
 * `solution_search` — model-facing tool. It is a thin wrapper over the shared
 * `rankSolutions` engine: never a second ranking implementation.
 */

interface SolutionSearchInput {
	query: string;
	repoRoot: string;
	mode?: SolutionRankingMode;
	limit?: number;
}

interface SolutionSearchToolResult {
	text: string;
	result: SolutionRankingResult;
}

export interface SolutionSearchDeps {
	jev?: JevRuntime;
	/** Built lazily on first execute so importing this module never spawns a process. */
	jevFactory?: () => JevRuntime;
}

/** Pure text formatter for the model-facing tool result. */
function formatSolutionSearchText(result: SolutionRankingResult): string {
	const lines: string[] = [];
	if (result.conflicts.length > 0) {
		lines.push(
			`⚠️ Potential conflicts with existing solutions: ${result.conflicts.join(", ")}`,
		);
	}
	if (result.status === "none" || result.results.length === 0) {
		lines.push("No relevant solutions found.");
		return lines.join("\n");
	}
	if (result.status === "degraded") {
		lines.push(
			"⚠️ Jev ranking unavailable — showing deterministic prior-ranked solutions (degraded).",
		);
	} else {
		lines.push(`Found ${result.results.length} relevant solution(s):`);
	}

	result.results.forEach((solution, index) => {
		lines.push("");
		lines.push(`### ${index + 1}. ${solution.title || solution.path}`);
		lines.push(...formatSolutionMetaLines(solution));
		lines.push(`- rank: ${solution.rank.toFixed(3)}`);
		lines.push(`- confidence: ${solution.confidence.toFixed(3)}`);
		lines.push(`- source: ${solution.source}`);
		lines.push("");
		lines.push(solution.content);
	});

	return lines.join("\n");
}

export function createSolutionSearchTool(deps: SolutionSearchDeps = {}) {
	let cachedJev: JevRuntime | null = deps.jev ?? null;

	const getJev = (): JevRuntime => {
		if (cachedJev) return cachedJev;
		cachedJev = deps.jevFactory ? deps.jevFactory() : createJevRuntime();
		return cachedJev;
	};

	return {
		name: "solution_search",
		description:
			"Search prior solution artifacts under docs/solutions and return the most relevant cards with their full text. Use before planning, reviewing, or learning to reuse earlier lessons.",
		async execute(
			input: SolutionSearchInput,
		): Promise<SolutionSearchToolResult> {
			const config = await readPiPedstackConfig(input.repoRoot);
			const ranking = resolveSolutionRankingConfig(config);
			const result = await rankSolutions({
				query: input.query,
				repoRoot: input.repoRoot,
				jev: getJev(),
				thresholds: ranking,
				shadow: ranking.shadow,
				limit: input.limit,
				mode: input.mode,
			});
			return { text: formatSolutionSearchText(result), result };
		},
	};
}
