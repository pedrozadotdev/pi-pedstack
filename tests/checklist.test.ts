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
			const result = await addTool.execute({ descriptions: ["Task A"] });

			expect(result).toEqual({
				items: [{ index: 1, description: "Task A" }],
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(1);
			expect(data.items[0].description).toBe("Task A");
			expect(data.items[0].addedAt).toBeDefined();
		});

		test("adds multiple tasks at once with correct indexes", async () => {
			const result = await addTool.execute({
				descriptions: ["Task 1", "Task 2", "Task 3"],
			});

			expect(result).toEqual({
				items: [
					{ index: 1, description: "Task 1" },
					{ index: 2, description: "Task 2" },
					{ index: 3, description: "Task 3" },
				],
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(3);
			expect(data.items[0].description).toBe("Task 1");
			expect(data.items[1].description).toBe("Task 2");
			expect(data.items[2].description).toBe("Task 3");
		});

		test("adds multiple tasks across consecutive calls", async () => {
			await addTool.execute({ descriptions: ["Task 1"] });
			const result2 = await addTool.execute({ descriptions: ["Task 2"] });
			const result3 = await addTool.execute({ descriptions: ["Task 3"] });

			expect(result2).toEqual({
				items: [{ index: 2, description: "Task 2" }],
			});
			expect(result3).toEqual({
				items: [{ index: 3, description: "Task 3" }],
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(3);
		});

		test("accepts empty descriptions array", async () => {
			const result = await addTool.execute({ descriptions: [] });
			expect(result.items).toEqual([]);

			const data = await readChecklist();
			expect(data.items).toHaveLength(0);
		});

		test("accepts list with empty string description", async () => {
			const result = await addTool.execute({ descriptions: [""] });
			expect(result.items).toHaveLength(1);
			expect(result.items[0].index).toBe(1);
			expect(result.items[0].description).toBe("");
		});
	});

	describe("checklist_show", () => {
		test("shows added tasks with 1-based indexes", async () => {
			await addTool.execute({ descriptions: ["Task A"] });
			await addTool.execute({ descriptions: ["Task B"] });

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

		test("shows tasks added in bulk with correct indexes", async () => {
			await addTool.execute({ descriptions: ["Task X", "Task Y", "Task Z"] });

			const result = await showTool.execute({});

			expect(result.count).toBe(3);
			expect(result.items[0]).toMatchObject({
				index: 1,
				description: "Task X",
			});
			expect(result.items[2]).toMatchObject({
				index: 3,
				description: "Task Z",
			});
		});

		test("returns empty when checklist is empty", async () => {
			const result = await showTool.execute({});
			expect(result.count).toBe(0);
			expect(result.items).toEqual([]);
		});
	});

	describe("checklist_del", () => {
		test("deletes a single task by index", async () => {
			await addTool.execute({ descriptions: ["Task A", "Task B", "Task C"] });

			const result = await delTool.execute({ indexes: [2] });

			expect(result).toEqual({
				removed: [2],
				count: 2,
			});

			const data = await readChecklist();
			expect(data.items).toHaveLength(2);
			expect(data.items[0].description).toBe("Task A");
			expect(data.items[1].description).toBe("Task C");
		});

		test("deduplicates indexes", async () => {
			await addTool.execute({ descriptions: ["Task A", "Task B"] });

			const result = await delTool.execute({ indexes: [1, 1, 2] });

			expect(result).toEqual({
				removed: [1, 2],
				count: 0,
			});
		});

		test("throws on invalid indexes", async () => {
			await addTool.execute({ descriptions: ["Task A"] });

			expect(delTool.execute({ indexes: [99, -1] })).rejects.toThrow(
				/Invalid checklist index/,
			);

			// Valid index alone should succeed
			const result = await delTool.execute({ indexes: [1] });
			expect(result).toEqual({
				removed: [1],
				count: 0,
			});
		});

		test("throws on delete from empty checklist", async () => {
			expect(delTool.execute({ indexes: [1] })).rejects.toThrow(
				/Invalid checklist index/,
			);
		});

		test("throws on non-integer indexes", async () => {
			await addTool.execute({ descriptions: ["Task A"] });

			expect(delTool.execute({ indexes: [1.5] })).rejects.toThrow(
				/Invalid checklist index/,
			);
		});
	});
});
