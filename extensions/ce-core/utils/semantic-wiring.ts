// Registration for the semantic read/scout tools (plan Unit 5). Mirrors
// `solution-wiring.ts`: one shared lazy Jev runtime per extension instance, so
// importing this module never spawns a process.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevRuntime } from "../jev/runtime";
import { diagnosticJevOptions } from "../diagnostics";
import { getActiveStage } from "./active-stage";
import type { JevRuntime } from "../jev/types";
import { createSemanticReadTool } from "../tools/semantic-read";
import { createSemanticScoutTool } from "../tools/semantic-scout";

const questionTypeParams = Type.Optional(
	Type.Union(
		[Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")],
		{ description: "Question type: noul (default), choice, or score" },
	),
);

const semanticReadParams = Type.Object({
	repoRoot: Type.String({ description: "Repository root for containment" }),
	path: Type.String({ description: "Repo-relative file path to judge" }),
	question: Type.String({
		description: "One bounded semantic question (≤ 2000 characters)",
	}),
	type: questionTypeParams,
	criteria: Type.Optional(Type.Unknown()),
});

const semanticScoutParams = Type.Object({
	repoRoot: Type.String({ description: "Repository root for containment" }),
	targets: Type.Array(
		Type.String({
			description: "Repo-relative files, directories, and/or globs (`*`, `**`)",
		}),
	),
	question: Type.String({
		description: "One bounded semantic question (≤ 2000 characters)",
	}),
	type: questionTypeParams,
	criteria: Type.Optional(Type.Unknown()),
	select: Type.Optional(
		Type.Boolean({
			description: "Run the second-pass Choice to recommend the first file to open",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of paths to score (hard cap 32)" }),
	),
});

let sharedJev: JevRuntime | null = null;

/** One Jev runtime per extension instance, created on first real use. */
function getSharedJev(): JevRuntime {
	if (sharedJev) return sharedJev;
	sharedJev = createJevRuntime({ ...diagnosticJevOptions("semantic_files", getActiveStage) });
	return sharedJev;
}

/** Register the model-facing `semantic_read` and `semantic_scout` tools. */
export function registerSemanticTools(pi: ExtensionAPI): void {
	const readTool = createSemanticReadTool({ jevFactory: getSharedJev });
	pi.registerTool({
		name: readTool.name,
		label: "Semantic Read",
		description: readTool.description,
		parameters: semanticReadParams,
		async execute(_toolCallId, params) {
			const { text, result } = await readTool.execute({
				repoRoot: params.repoRoot,
				path: params.path,
				question: params.question,
				type: params.type,
				criteria: params.criteria,
			});
			return { content: [{ type: "text", text }], details: result };
		},
	});

	const scoutTool = createSemanticScoutTool({ jevFactory: getSharedJev });
	pi.registerTool({
		name: scoutTool.name,
		label: "Semantic Scout",
		description: scoutTool.description,
		parameters: semanticScoutParams,
		async execute(_toolCallId, params) {
			const { text, result } = await scoutTool.execute({
				repoRoot: params.repoRoot,
				targets: params.targets,
				question: params.question,
				type: params.type,
				criteria: params.criteria,
				select: params.select,
				limit: params.limit,
			});
			return { content: [{ type: "text", text }], details: result };
		},
	});
}
