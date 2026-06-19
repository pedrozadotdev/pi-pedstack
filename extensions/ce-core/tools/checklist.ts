import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface ChecklistItem {
	description: string;
	addedAt: string;
}

export interface ChecklistData {
	items: ChecklistItem[];
}

// ── State File Helpers ─────────────────────────────────────────────

const CHECKLIST_DIR = ".context";
const CHECKLIST_FILE = path.join(CHECKLIST_DIR, "checklist.json");

function checklistFilePath(cwd?: string): string {
	const root = cwd ?? process.cwd();
	return path.join(root, CHECKLIST_FILE);
}

export async function readChecklist(cwd?: string): Promise<ChecklistData> {
	const filePath = checklistFilePath(cwd);
	try {
		const content = await readFile(filePath, "utf8");
		return JSON.parse(content) as ChecklistData;
	} catch {
		return { items: [] };
	}
}

async function writeChecklist(
	data: ChecklistData,
	cwd?: string,
): Promise<void> {
	const filePath = checklistFilePath(cwd);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── Tool: checklist_add ────────────────────────────────────────────

export function createChecklistAddTool() {
	return {
		name: "checklist_add",
		async execute(input: {
			descriptions: string[];
		}): Promise<{ items: Array<{ index: number; description: string }> }> {
			const data = await readChecklist();
			const added: Array<{ index: number; description: string }> = [];

			for (const desc of input.descriptions) {
				const item: ChecklistItem = {
					description: desc,
					addedAt: new Date().toISOString(),
				};
				data.items.push(item);
				added.push({
					index: data.items.length,
					description: desc,
				});
			}

			await writeChecklist(data);

			return { items: added };
		},
	};
}

// ── Tool: checklist_show ───────────────────────────────────────────

export function createChecklistShowTool() {
	return {
		name: "checklist_show",
		async execute(_input: Record<string, never>): Promise<{
			items: Array<{ index: number; description: string; addedAt: string }>;
			count: number;
		}> {
			const data = await readChecklist();

			const items = data.items.map((item, idx) => ({
				index: idx + 1,
				description: item.description,
				addedAt: item.addedAt,
			}));

			return {
				items,
				count: items.length,
			};
		},
	};
}

// ── Tool: checklist_del ────────────────────────────────────────────

export function createChecklistDelTool() {
	return {
		name: "checklist_del",
		async execute(input: { indexes: number[] }): Promise<{
			removed: number[];
			skipped: number[];
			count: number;
		}> {
			const data = await readChecklist();
			const removed: number[] = [];
			const skipped: number[] = [];

			// Deduplicate and sort descending (to maintain index stability during removal)
			const uniqueDesc = [...new Set(input.indexes)]
				.filter((n) => Number.isInteger(n))
				.sort((a, b) => b - a);

			for (const idx of uniqueDesc) {
				if (idx >= 1 && idx <= data.items.length) {
					data.items.splice(idx - 1, 1);
					removed.push(idx);
				} else {
					skipped.push(idx);
				}
			}

			// Restore ascending order for removed
			removed.sort((a, b) => a - b);

			await writeChecklist(data);

			return {
				removed,
				skipped,
				count: data.items.length,
			};
		},
	};
}
