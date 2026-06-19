import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// --- Types ---

export interface TodoTask {
	id: number;
	task: string;
	status: "pending" | "done";
	createdAt: string;
	updatedAt: string;
}

export interface TodoState {
	tasks: TodoTask[];
	nextId: number;
}

export interface TodoAddInput {
	repoRoot: string;
	task: string;
}

export interface TodoListInput {
	repoRoot: string;
	filter?: "all" | "pending" | "done";
}

export interface TodoDoneInput {
	repoRoot: string;
	taskId: number;
}

export interface TodoAddResult {
	operation: "todo_add";
	task: TodoTask;
}

export interface TodoListResult {
	operation: "todo_list";
	tasks: TodoTask[];
	total: number;
	filter: string;
}

export interface TodoDoneResult {
	operation: "todo_done";
	success: boolean;
	task: TodoTask;
}

// --- Helpers ---

function todoStatePath(repoRoot: string): string {
	return path.join(
		repoRoot,
		".context",
		"compound-engineering",
		"todo-state.json",
	);
}

async function readTodoState(repoRoot: string): Promise<TodoState> {
	const filePath = todoStatePath(repoRoot);
	if (!existsSync(filePath)) {
		return { tasks: [], nextId: 1 };
	}
	try {
		const content = await readFile(filePath, "utf8");
		return JSON.parse(content);
	} catch {
		return { tasks: [], nextId: 1 };
	}
}

async function writeTodoState(
	repoRoot: string,
	state: TodoState,
): Promise<void> {
	const filePath = todoStatePath(repoRoot);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

// --- Tool factory functions ---

export function createTodoAddTool() {
	return {
		name: "todo_add",
		description: "Register a new pending task in the persistent todo list.",
		async execute(input: TodoAddInput): Promise<TodoAddResult> {
			const state = await readTodoState(input.repoRoot);
			const now = new Date().toISOString();
			const task: TodoTask = {
				id: state.nextId,
				task: input.task,
				status: "pending",
				createdAt: now,
				updatedAt: now,
			};
			state.tasks.push(task);
			state.nextId++;
			await writeTodoState(input.repoRoot, state);
			return { operation: "todo_add", task };
		},
	};
}

export function createTodoListTool() {
	return {
		name: "todo_list",
		description:
			"List tasks in the persistent todo list with optional status filter.",
		async execute(input: TodoListInput): Promise<TodoListResult> {
			const state = await readTodoState(input.repoRoot);
			const filter = input.filter ?? "all";
			let filtered: TodoTask[];
			if (filter === "all") {
				filtered = state.tasks;
			} else {
				filtered = state.tasks.filter((t) => t.status === filter);
			}
			return {
				operation: "todo_list",
				tasks: filtered,
				total: filtered.length,
				filter,
			};
		},
	};
}

export function createTodoDoneTool() {
	return {
		name: "todo_done",
		description: "Remove a completed task from the todo list by its ID.",
		async execute(input: TodoDoneInput): Promise<TodoDoneResult> {
			const state = await readTodoState(input.repoRoot);
			const index = state.tasks.findIndex((t) => t.id === input.taskId);
			if (index === -1) {
				throw new Error(`Task with id ${input.taskId} not found`);
			}
			const [task] = state.tasks.splice(index, 1);
			await writeTodoState(input.repoRoot, state);
			return {
				operation: "todo_done",
				success: true,
				task,
			};
		},
	};
}

// Shared helper for reading todo state (for context-handoff integration)
export async function readTodoStateForRepo(
	repoRoot: string,
): Promise<TodoState> {
	return readTodoState(repoRoot);
}
