/**
 * Explicit stage-policy registry: each pipeline stage's mandate, forbidden
 * activity, and next stage.
 *
 * Owned outside the command layer so prose injection and the drift detector
 * share one authority. Pure: no I/O. The record keys are the runtime allowlist.
 *
 * @module stage-policy
 */

import type { PipelineStageKey } from "../commands/pedstack";

export interface StageDiscipline {
	/** What the model MUST do in this stage. */
	mandate: string;
	/** What the model MUST NOT do in this stage. */
	forbidden: string;
	/** The default next stage, or null for the terminal stage. */
	nextStage: PipelineStageKey | null;
	/** Optional conditional completion instruction that overrides the default prompt. */
	completionInstruction?: string;
}

export const STAGE_DISCIPLINES: Record<PipelineStageKey, StageDiscipline> = {
	"01-brainstorm": {
		mandate:
			"Explore ideas, analyze requirements, research approaches, and critically evaluate tradeoffs. Your output is a brainstorm document that sets direction.",
		forbidden:
			"Do NOT write plans, do NOT design architecture, do NOT create specifications, and do NOT write or edit any source code.",
		nextStage: "02-plan",
	},
	"02-plan": {
		mandate:
			"Translate brainstorm output into a concrete, actionable implementation plan with clear units, file paths, dependencies, and order of work.",
		forbidden:
			"Do NOT write or edit any source code, do NOT implement anything, do NOT redesign the solution — only plan.",
		nextStage: "03-work",
	},
	"03-work": {
		mandate:
			"Implement the code exactly as specified in the plan. Write tests, run them, and ensure they pass. Stay focused on the planned scope.",
		forbidden:
			"Do NOT change scope, do NOT redesign the architecture, do NOT skip planned steps, and do NOT move to review without passing tests.",
		nextStage: "04-review",
	},
	"04-review": {
		mandate:
			"Review every changed file for correctness, style, type safety, test coverage, and adherence to project standards.",
		forbidden:
			"Do NOT modify code, do NOT re-implement anything, do NOT add features, and do NOT fix issues yourself — only identify, verify, and document them.",
		nextStage: "05-learn",
		completionInstruction:
			'When review is complete, inspect the compiled report Review Outcome and save a context handoff (using the context_handoff tool with operation="save"). If Status is "findings", target **03-work** so confirmed findings are fixed and then reviewed again. Only when Status is "clean" with Findings: 0 may the handoff target **05-learn**. Do NOT carry unresolved findings into learning.',
	},
	"04-5-debug": {
		mandate:
			"Find the root cause of bugs or issues and fix them. Make targeted, minimal changes to resolve each verified issue.",
		forbidden:
			"Do NOT add new features, do NOT change scope, do NOT refactor unrelated code — fix only what is broken.",
		nextStage: "05-learn",
	},
	"05-learn": {
		mandate:
			"Synthesize learnings, extract patterns, identify what worked and what didn't, and document insights for future work.",
		forbidden:
			"Do NOT modify source code, do NOT re-implement anything, do NOT add features — only learn, document, and produce the learnings artifact.",
		nextStage: "06-docsync",
	},
	"06-docsync": {
		mandate:
			"Synchronize all documentation: update READMEs, ensure API docs are current, verify artifact records are complete, and produce a pipeline summary.",
		forbidden:
			"Do NOT modify source code, do NOT add features, do NOT re-implement anything — only documentation and artifact management.",
		nextStage: null,
	},
};

const STAGE_KEY_SET = new Set<string>(Object.keys(STAGE_DISCIPLINES));

/** Resolve a stage key to its discipline, or `null` when unknown/absent. */
export function getStageDiscipline(
	stage: string | null | undefined,
): StageDiscipline | null {
	if (typeof stage !== "string" || !STAGE_KEY_SET.has(stage)) return null;
	return STAGE_DISCIPLINES[stage as PipelineStageKey];
}
