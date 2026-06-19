import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import {
	createChecklistAddTool,
	createChecklistShowTool,
	createChecklistDelTool,
	readChecklist,
} from "../extensions/ce-core/tools/checklist";

// Use a temp directory approach: change cwd for each test so tools
// write to the test directory via process.cwd()
const TEST_DIR = path.resolve(`/tmp/pi-ce-checklist-test-${Date.now()}`);
const originalCwd = process.cwd();

describe("checklist tools", () => {
	const addTool = createChecklistAddTool();
	const showTool = createChecklistShowTool();
	const delTool = createChecklistDelTool();

	beforeEach(async () => {
		await mkdir(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	describe("checklist_add", () => {
		test("adds a single task and returns 1-based index", async () => {
			const result = await addTool.execute({ description: "Task A" });

			expect(result).toEqual({
				index: 1,
				description: "Task A",
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(1);
			expect(data.items[0].description).toBe("Task A");
			expect(data.items[0].addedAt).toBeDefined();
		});

		test("adds multiple tasks with incrementing indexes", async () => {
			await addTool.execute({ description: "Task 1" });
			const result2 = await addTool.execute({ description: "Task 2" });
			const result3 = await addTool.execute({ description: "Task 3" });

			expect(result2).toEqual({ index: 2, description: "Task 2" });
			expect(result3).toEqual({ index: 3, description: "Task 3" });

			const data = await readChecklist();
			expect(data.items).toHaveLength(3);
		});

		test("accepts empty string description", async () => {
			const result = await addTool.execute({ description: "" });
			expect(result.index).toBe(1);
		});
	});

	describe("checklist_show", () => {
		test("shows added tasks with 1-based indexes", async () => {
			await addTool.execute({ description: "Task A" });
			await addTool.execute({ description: "Task B" });

			const result = await showTool.execute({});

			expect(result.count).toBe(2);
			expect(result.items).toHaveLength(2);
			expect(result.items[0]).toMatchObject({
				index: 1,
				description: "Task A",
			});
			expect(result.items[1]).toMatchObject({
				index: 2,
				description: "Task B",
			});
			expect(result.items[0].addedAt).toBeDefined();
		});

		test("returns empty when checklist is empty", async () => {
			const result = await showTool.execute({});
			expect(result.count).toBe(0);
			expect(result.items).toEqual([]);
		});
	});

	describe("checklist_del", () => {
		test("deletes a single task by index", async () => {
			await addTool.execute({ description: "Task A" });
			await addTool.execute({ description: "Task B" });
			await addTool.execute({ description: "Task C" });

			const result = await delTool.execute({ indexes: [2] });

			expect(result).toEqual({
				removed: [2],
				skipped: [],
				count: 2,
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(2);
			expect(data.items[0].description).toBe("Task A");
			expect(data.items[1].description).toBe("Task C");
		});

		test("deduplicates indexes", async () => {
			await addTool.execute({ description: "Task A" });
			await addTool.execute({ description: "Task B" });

			const result = await delTool.execute({ indexes: [1, 1, 2] });

			expect(result.removed).toEqual([1, 2]);
			expect(result.count).toBe(0);
		});

		test("skips invalid indexes", async () => {
			await addTool.execute({ description: "Task A" });

			const result = await delTool.execute({ indexes: [1, 99, -1] });

			expect(result.removed).toEqual([1]);
			expect(result.skipped).toEqual([99, -1]);
			expect(result.count).toBe(0);
		});

		test("handles delete from empty checklist", async () => {
			const result = await delTool.execute({ indexes: [1] });

			expect(result.removed).toEqual([]);
			expect(result.skipped).toEqual([1]);
			expect(result.count).toBe(0);
		});
	});
});
