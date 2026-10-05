import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	extractStageKey,
	formatSolutionsBlock,
} from "../commands/prompt-inject";
import { createSolutionSearchTool } from "../tools/solution-search";
import type { SolutionSearchDeps } from "../tools/solution-search";
import {
	readPiPedstackConfig,
	resolveSolutionRankingConfig,
} from "./config-types";
import { collectInjectionQuery } from "./solution-query";
import {
	rankSolutions,
	type SolutionShadowRecord,
} from "./solution-ranking";

/**
 * Wiring for solution ranking: the `solution_search` tool registration plus the
 * auto-injection helper that the existing `before_agent_start` handler awaits.
 *
 * There is deliberately only ONE `before_agent_start` handler (in `index.ts`);
 * this module exposes a pure-ish helper rather than registering a second one.
 */

/** Stages that auto-inject prior solutions. */
const TARGET_STAGES = new Set(["02-plan", "04-review", "04-5-debug", "05-learn"]);

export interface SolutionInjectionDeps {
	jev?: JevRuntime;
	/** Override the config shadow flag (tests force the enforced path). */
	shadow?: boolean;
	telemetry?: (record: SolutionShadowRecord) => void;
}

export interface SolutionInjectionInput {
	repoRoot: string;
	skillPath: string | null;
}

const solutionSearchParams = Type.Object({
	query: Type.String({
		description:
			"Natural-language description of the current task or problem to match against prior solutions.",
	}),
	repoRoot: Type.String({ description: "Repository root to search" }),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("recall"), Type.Literal("overlap")],
			{ description: "Question set: recall (default) or overlap detection" },
		),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of solutions to return" }),
	),
});

let sharedJev: JevRuntime | null = null;
let sharedJevFactory: (() => JevRuntime) | undefined;

/** One Jev runtime per extension instance, created on first real use. */
function getSharedJev(): JevRuntime {
	if (sharedJev) return sharedJev;
	sharedJev = sharedJevFactory ? sharedJevFactory() : createJevRuntime();
	return sharedJev;
}

/** Register the model-facing `solution_search` tool. */
export function registerSolutionSearch(
	pi: ExtensionAPI,
	deps: SolutionSearchDeps = {},
): void {
	if (deps.jev) sharedJev = deps.jev;
	if (deps.jevFactory) sharedJevFactory = deps.jevFactory;

	const tool = createSolutionSearchTool({ jevFactory: getSharedJev });
	pi.registerTool({
		name: tool.name,
		label: "Solution Search",
		description: tool.description,
		parameters: solutionSearchParams,
		async execute(_toolCallId, params) {
			const { text, result } = await tool.execute({
				query: params.query,
				repoRoot: params.repoRoot,
				mode: params.mode,
				limit: params.limit,
			});
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});
}

/**
 * Build the auto-injected solutions block for a stage transition. Returns
 * `undefined` when nothing should be injected or when anything fails — the
 * turn must never break. Shadow mode computes + logs but never injects.
 */
export async function buildSolutionsAppend(
	input: SolutionInjectionInput,
	deps: SolutionInjectionDeps = {},
): Promise<string | undefined> {
	try {
		const stageKey = input.skillPath ? extractStageKey(input.skillPath) : null;
		if (!stageKey || !TARGET_STAGES.has(stageKey)) return undefined;

		const query = await collectInjectionQuery({
			repoRoot: input.repoRoot,
			stageKey,
		});
		if (!query) return undefined;

		const config = await readPiPedstackConfig(input.repoRoot);
		const ranking = resolveSolutionRankingConfig(config);
		const result = await rankSolutions({
			query,
			repoRoot: input.repoRoot,
			jev: deps.jev ?? getSharedJev(),
			thresholds: ranking,
			shadow: deps.shadow ?? ranking.shadow,
			telemetry: deps.telemetry,
		});
		// Shadow-first: compute + log, but only inject once enforcement is on.
		if (!result.enforced) return undefined;
		return formatSolutionsBlock(result);
	} catch {
		return undefined;
	}
}

/**
 * Compose the `before_agent_start` result. Returns `undefined` (never an empty
 * append) when there is nothing to inject, preserving handler chaining.
 */
export function composeSolutionSystemPrompt(
	base: string,
	append: string,
	solutionsBlock: string | undefined,
): { systemPrompt: string } | undefined {
	if (!append && !solutionsBlock) return undefined;
	return { systemPrompt: base + append + (solutionsBlock ?? "") };
}
