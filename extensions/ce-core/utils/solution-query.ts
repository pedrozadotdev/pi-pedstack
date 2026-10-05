import { readContextState } from "../tools/workflow-state";
import { truncateUtf8ToBytes } from "./solution-recall";

/**
 * Auto-injection query builder. It reads `.context/compound-engineering/context-state.json`
 * and assembles a bounded query from the deterministic context fields — no model,
 * no I/O beyond that file.
 */

const QUERY_BOUND_BYTES = 2048;

/** Stage-specific context field appended after currentTruth + activeFiles. */
const STAGE_CONTEXT_FIELD: Record<
	string,
	"openDecisions" | "blocker" | "invalidatedAssumptions" | undefined
> = {
	"02-plan": "openDecisions",
	"04-review": "openDecisions",
	"04-5-debug": "blocker",
	"05-learn": "invalidatedAssumptions",
};

export interface CollectInjectionQueryInput {
	repoRoot: string;
	stageKey: string;
}

/**
 * Assemble the auto-injection query in order: latest `currentTruth`, active
 * files, then the stage's pending context. Returns `null` when nothing can be
 * assembled so the caller can skip injection entirely.
 */
export async function collectInjectionQuery(
	input: CollectInjectionQueryInput,
): Promise<string | null> {
	const state = readContextState(input.repoRoot);
	if (!state.found) return null;

	const pieces: string[] = [...state.currentTruth, ...state.activeFiles];

	const extraField = STAGE_CONTEXT_FIELD[input.stageKey];
	if (extraField) {
		const value = state[extraField];
		if (typeof value === "string") {
			pieces.push(value);
		} else if (Array.isArray(value)) {
			pieces.push(...value);
		}
	}

	const query = pieces
		.filter((piece): piece is string => typeof piece === "string")
		.map((piece) => piece.trim())
		.filter((piece) => piece.length > 0)
		.join("\n");

	if (query.length === 0) return null;
	return truncateUtf8ToBytes(query, QUERY_BOUND_BYTES);
}
