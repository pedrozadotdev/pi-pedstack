import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Step name mapping from skill trigger names to simple config names.
 * Used for APPEND file lookup.
 */
const SKILL_TO_SIMPLE_NAME: Record<string, string> = {
	"01-brainstorm": "brainstorm",
	"02-plan": "plan",
	"03-work": "work",
	"04-review": "review",
	"04-5-debug": "debug",
	"05-learn": "learn",
	"06-docsync": "docsync",
};

/**
 * Load per-step context from `<project-root>/.agents/appends/{STEP_NAME}.md`.
 * E.g., `<project-root>/.agents/appends/BRAINSTORM.md`.
 *
 * @param cwd - Project root directory
 * @param skillName - Skill trigger name (e.g. "01-brainstorm")
 * @returns File contents if found, null otherwise
 */
export async function loadAppendContext(
	cwd: string,
	skillName: string,
): Promise<string | null> {
	const simpleName = SKILL_TO_SIMPLE_NAME[skillName];
	if (!simpleName) return null;

	const filename = `${simpleName.toUpperCase()}.md`;
	const appendPath = path.join(cwd, ".agents", "appends", filename);

	try {
		const content = await readFile(appendPath, "utf8");
		return content.trim() || null;
	} catch {
		return null;
	}
}
