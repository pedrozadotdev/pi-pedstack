// `semantic_read` — model-facing tool (plan Unit 5). A thin wrapper over the
// shared `askSemanticFile` engine: one file, one bounded question, typed answer,
// never a file body.
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	readPiPedstackConfig,
	resolveSemanticReadConfig,
} from "../utils/config-types";
import {
	askSemanticFile,
	SEMANTIC_DEGRADED_GUIDANCE,
	type AskSemanticFileResult,
	type SemanticAnswer,
	type SemanticQuestionType,
} from "../utils/semantic-file-ask";

interface SemanticReadToolInput {
	repoRoot: string;
	path: string;
	question: string;
	type?: SemanticQuestionType;
	criteria?: unknown;
}

interface SemanticReadToolResult {
	text: string;
	result: AskSemanticFileResult;
}

export interface SemanticReadDeps {
	jev?: JevRuntime;
	/** Built lazily on first execute so importing this module never spawns a process. */
	jevFactory?: () => JevRuntime;
}

/** Pure, body-free one-line rendering of a typed answer. */
export function describeSemanticAnswer(answer: SemanticAnswer): string {
	if (answer.kind === "noul") {
		return `noul=${answer.value.toFixed(3)} confidence=${answer.confidence.toFixed(3)}`;
	}
	if (answer.kind === "score") {
		return `score=${answer.value} confidence=${answer.confidence.toFixed(3)}`;
	}
	return `choice=${answer.label} confidence=${answer.confidence.toFixed(3)}`;
}

/** Render the ok-path facts + typed answer (never the body). */
function formatReadOk(result: AskSemanticFileResult, answer: SemanticAnswer): string {
	return [
		`path: ${result.path}`,
		`fileBytes: ${result.fileBytes ?? 0}`,
		`excerptBytes: ${result.excerptBytes ?? 0}`,
		`truncated: ${result.truncated ?? false}`,
		`answer: ${describeSemanticAnswer(answer)}`,
		"(typed answer only — never file bodies)",
	].join("\n");
}

/** Pure text formatter for the model-facing tool result. */
function formatSemanticReadText(result: AskSemanticFileResult): string {
	if (result.status === "ok" && result.answer) return formatReadOk(result, result.answer);
	if (result.status === "degraded") {
		return [
			`path: ${result.path}`,
			`status: degraded (${result.degradedReason ?? "jev_error"})`,
			result.guidance ?? SEMANTIC_DEGRADED_GUIDANCE,
		].join("\n");
	}
	return [`path: ${result.path}`, "status: error", `reason: ${result.reason ?? "jev_error"}`].join("\n");
}

export function createSemanticReadTool(deps: SemanticReadDeps = {}) {
	let cachedJev: JevRuntime | null = deps.jev ?? null;

	const getJev = (): JevRuntime => {
		if (cachedJev) return cachedJev;
		cachedJev = deps.jevFactory ? deps.jevFactory() : createJevRuntime();
		return cachedJev;
	};

	return {
		name: "semantic_read",
		description:
			"Answer a bounded semantic question about ONE repo file and return a typed answer (noul probability / choice label / score) plus byte facts. Results are typed answers, never file bodies. Use semantic_read for judgments (does this file matter?); use `read` for exact text or editing and `grep`/the code graph for deterministic facts. If Jev is unavailable it degrades to explicit `read`/`grep` guidance.",
		async execute(input: SemanticReadToolInput): Promise<SemanticReadToolResult> {
			const config = await readPiPedstackConfig(input.repoRoot);
			const budgets = resolveSemanticReadConfig(config);
			const result = await askSemanticFile({
				repoRoot: input.repoRoot,
				path: input.path,
				question: input.question,
				type: input.type,
				criteria: input.criteria,
				budgets,
				jev: getJev(),
			});
			return { text: formatSemanticReadText(result), result };
		},
	};
}
