import {
	isValidStageKey,
	type PipelineStageKey,
	getAndClearPendingAppendContent,
} from "./pedstack";

/**
 * Extract the stage key (e.g. "01-brainstorm") from a SKILL.md path.
 * Supports both POSIX (/skills/01-brainstorm/SKILL.md) and Windows
 * (C:\\skills\\01-brainstorm\\SKILL.md) separators.
 * Returns null for unrecognized paths.
 */
export function extractStageKey(skillPath: string): string | null {
	const match = skillPath.match(/([^/\\]+)[/\\]SKILL\.md$/);
	return match ? match[1] : null;
}

// ── Stage-specific pipeline discipline instructions ────────────────

interface StageDiscipline {
	/** What the model MUST do in this stage. */
	mandate: string;
	/** What the model MUST NOT do in this stage. */
	forbidden: string;
	/** The next stage to handoff to, or null for the terminal stage. */
	nextStage: PipelineStageKey | null;
}

const STAGE_DISCIPLINES: Record<PipelineStageKey, StageDiscipline> = {
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
			"Do NOT modify code, do NOT re-implement anything, do NOT add features, and do NOT fix issues yourself — only identify and document them.",
		nextStage: "05-learn",
	},
	"04-5-debug": {
		mandate:
			"Fix only the bugs and issues identified during review. Make targeted, minimal changes to resolve each issue.",
		forbidden:
			"Do NOT add new features, do NOT change scope, do NOT refactor unrelated code — fix only what was flagged.",
		nextStage: "04-review",
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

/**
 * Build the system prompt append block for a pending skill path, fix-issues,
 * and per-stage APPEND.md context.
 *
 * Injection order: Pipeline Discipline guard → Append instructions → skill-reading → fix-issues fetch.
 * Returns empty string when nothing to inject.
 */
export function buildSystemPromptAppend(
	skillPath: string | null,
	fixIssues: string[],
): string {
	const blocks: string[] = [];
	const stageKey = skillPath ? extractStageKey(skillPath) : null;

	// 1. Pipeline Discipline guard
	if (stageKey && isValidStageKey(stageKey)) {
		const d = STAGE_DISCIPLINES[stageKey];
		const nextStageNote = d.nextStage
			? `When you have completed this stage's work, save a context handoff (using the context_handoff tool with operation="save") targeting the next stage: **${d.nextStage}**. Do NOT proceed to the next stage yourself — stop after the handoff.`
			: 'When all documentation is synced, save a final context handoff (using the context_handoff tool with operation="save") marking the pipeline as complete. This is the terminal stage.';

		blocks.push(
			`\n\n---\n## 🚦 Pipeline Discipline: Stage Focus\n\n` +
				`You are entering stage **${stageKey}**. This stage has a strict mandate:\n\n` +
				`**Your mandate:** ${d.mandate}\n\n` +
				`**Forbidden:** ${d.forbidden}\n\n` +
				`${nextStageNote}`,
		);
	} else if (stageKey) {
		// Unrecognized stage — generic no-implementation guard
		blocks.push(
			"\n\n---\n## ⛔ Pipeline Discipline: No Implementation\n\n" +
				"You are entering stage " +
				stageKey +
				". You must NEVER write, edit, modify, " +
				"or delete any source code files. Do not jump to implementation. " +
				"Stay strictly within the scope of this stage. Implementation " +
				"belongs exclusively to the 03-work stage and may only happen there.",
		);
	}

	// 2. Per-stage APPEND.md instructions (user-provided)
	const appendContent = getAndClearPendingAppendContent();
	if (appendContent) {
		blocks.push(
			"\n\n---\n## 📋 Stage Append Instructions\n\n" +
				"The following project-specific instructions apply to this stage:\n\n" +
				appendContent,
		);
	}

	// 3. Skill-reading instruction (for any non-empty skill path)
	if (skillPath) {
		blocks.push(
			"\n\n---\n## 📖 Pipeline Stage: Skill Instructions\n\n" +
				"You are entering a new pipeline stage. You MUST immediately read the following " +
				"skill file using the read tool to understand this stage's purpose, rules, and " +
				"expectations:\n\n" +
				skillPath +
				"\n\nAfter reading the skill, follow its instructions precisely.",
		);
	}

	// 3. Fix-issues fetch instruction (only for 01-brainstorm)
	if (fixIssues.length > 0 && stageKey === "01-brainstorm") {
		const issueList = fixIssues.map((n) => "#" + n).join(", ");
		blocks.push(
			"\n\n---\n## Fetch GitHub Issues for Context\n\n" +
				"Your task is to fetch the details of specific GitHub issue(s) using the GitHub CLI " +
				"(`gh`) and then use that information as context to execute the brainstorming skill.\n\n" +
				"**Steps:**\n" +
				"1. **Fetch Issue Details:**\n" +
				"   - Run `gh issue view <number>` for each issue: " +
				issueList +
				"\n" +
				"   - You may also run `gh issue view <number> --comments` to get additional context " +
				"from the issue discussion.\n" +
				"   - Analyze the retrieved content to understand the problem, feature request, or requirements.\n\n" +
				"2. **Execute the Brainstorm Skill:**\n" +
				"   - Once you have the full context of the issues, follow the instructions in the " +
				"brainstorm SKILL.md.\n" +
				"   - Provide the issue details (title, description, and relevant comments) as the " +
				"context/input for the brainstorming session.",
		);
	}

	return blocks.join("");
}
