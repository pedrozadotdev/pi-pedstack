import { isValidStageKey } from "./pedstack";

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

/**
 * Build the system prompt append block for a pending skill path and fix-issues.
 *
 * Injection order: Pipeline Discipline guard → skill-reading → fix-issues fetch.
 * Returns empty string when nothing to inject.
 */
export function buildSystemPromptAppend(
	skillPath: string | null,
	fixIssues: string[],
): string {
	const blocks: string[] = [];
	const stageKey = skillPath ? extractStageKey(skillPath) : null;

	// 1. Pipeline Discipline guard (not for 03-work or unrecognized stages)
	if (stageKey && isValidStageKey(stageKey) && stageKey !== "03-work") {
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

	// 2. Skill-reading instruction (for any non-empty skill path)
	if (skillPath) {
		blocks.push(
			"\n\n---\n## Pipeline Stage: Skill Instructions\n\n" +
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
