import { describe, expect, test, mock, afterEach } from "bun:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

mock.module("@earendil-works/pi-ai", () => {
	return {
		completeSimple: async (model: any, prompt: any, options: any) => {
			return {
				content: [
					{ type: "text", text: "A simulated description of the image." },
				],
				stopReason: "stop",
			};
		},
	};
});

mock.module("node:child_process", () => {
	return {
		spawn: (command: string, args: string[], options: any) => {
			const listeners: Record<string, Function[]> = {};
			const stdoutListeners: Record<string, Function[]> = {};

			const proc = {
				stdout: {
					on: (event: string, cb: Function) => {
						stdoutListeners[event] = stdoutListeners[event] || [];
						stdoutListeners[event].push(cb);
					},
				},
				stderr: {
					on: (event: string, cb: Function) => {
						// no-op for tests
					},
				},
				on: (event: string, cb: Function) => {
					listeners[event] = listeners[event] || [];
					listeners[event].push(cb);
				},
			};

			setTimeout(() => {
				const messageEvent = {
					type: "message_end",
					message: {
						content: [
							{
								type: "text",
								text: "```json\n[]\n```",
							},
						],
					},
				};
				const dataStr = JSON.stringify(messageEvent) + "\n";
				if (stdoutListeners["data"]) {
					for (const cb of stdoutListeners["data"]) {
						cb(Buffer.from(dataStr));
					}
				}

				if (listeners["close"]) {
					for (const cb of listeners["close"]) {
						cb(0);
					}
				}
			}, 5);

			return proc;
		},
	};
});

import { createTaskSplitterTool } from "../extensions/ce-core/tools/task-splitter";
import { createBrainstormDialogTool } from "../extensions/ce-core/tools/brainstorm-dialog";
import { createPlanDiffTool } from "../extensions/ce-core/tools/plan-diff";
import { createSessionHistoryTool } from "../extensions/ce-core/tools/session-history";
import { createPatternExtractorTool } from "../extensions/ce-core/tools/pattern-extractor";

describe("task_splitter", () => {
	test("all independent units are parallel-safe", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({
			units: [
				{ name: "Unit 1: auth", files: ["src/auth.ts"] },
				{ name: "Unit 2: docs", files: ["README.md"] },
				{ name: "Unit 3: CI", files: [".github/workflows/test.yml"] },
			],
		});

		expect(result.groups.length).toBe(3);
		for (const group of result.groups) {
			expect(group.parallelSafe).toBe(true);
		}
		expect(result.independentUnits.length).toBe(3);
		expect(result.dependentUnits.length).toBe(0);
	});

	test("two units sharing a file are grouped as dependent", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({
			units: [
				{ name: "Unit 1: types", files: ["src/types.ts", "src/auth.ts"] },
				{ name: "Unit 2: user", files: ["src/types.ts", "src/user.ts"] },
				{ name: "Unit 3: docs", files: ["README.md"] },
			],
		});

		expect(result.groups.length).toBe(2);

		const depGroup = result.groups.find((g) => !g.parallelSafe);
		expect(depGroup).toBeTruthy();
		expect(depGroup!.units.sort()).toEqual(["Unit 1: types", "Unit 2: user"]);
		expect(depGroup!.sharedFiles).toContain("src/types.ts");

		const indGroup = result.groups.find((g) => g.parallelSafe);
		expect(indGroup!.units).toEqual(["Unit 3: docs"]);

		expect(result.independentUnits).toEqual(["Unit 3: docs"]);
		expect(result.dependentUnits.sort()).toEqual([
			"Unit 1: types",
			"Unit 2: user",
		]);
	});

	test("three units all sharing files merge into one group", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({
			units: [
				{ name: "Unit 1", files: ["a.ts", "b.ts"] },
				{ name: "Unit 2", files: ["b.ts", "c.ts"] },
				{ name: "Unit 3", files: ["c.ts", "d.ts"] },
			],
		});

		expect(result.groups.length).toBe(1);
		expect(result.groups[0].parallelSafe).toBe(false);
		expect(result.groups[0].units.sort()).toEqual([
			"Unit 1",
			"Unit 2",
			"Unit 3",
		]);
		expect(result.independentUnits.length).toBe(0);
		expect(result.dependentUnits.length).toBe(3);
	});

	test("single unit is one parallel-safe group", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({
			units: [{ name: "Unit 1: solo", files: ["src/solo.ts"] }],
		});

		expect(result.groups.length).toBe(1);
		expect(result.groups[0].parallelSafe).toBe(true);
		expect(result.groups[0].units).toEqual(["Unit 1: solo"]);
		expect(result.independentUnits).toEqual(["Unit 1: solo"]);
	});

	test("empty input returns empty output", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({ units: [] });

		expect(result.groups).toEqual([]);
		expect(result.independentUnits).toEqual([]);
		expect(result.dependentUnits).toEqual([]);
	});

	test("unit with no files is treated as independent", () => {
		const tool = createTaskSplitterTool();

		const result = tool.execute({
			units: [
				{ name: "Unit 1: no files", files: [] },
				{ name: "Unit 2: has files", files: ["src/main.ts"] },
			],
		});

		expect(result.groups.length).toBe(2);
		expect(result.independentUnits.length).toBe(2);
		expect(result.dependentUnits.length).toBe(0);
	});
});

describe("brainstorm_dialog", () => {
	test("start creates a dialog with round 1", async () => {
		const repoRoot = `/tmp/pi-ce-bd-start-${Date.now()}`;
		const tool = createBrainstormDialogTool();

		const result = await tool.execute({
			operation: "start",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Initial analysis: user authentication needed",
			questions: ["What auth provider?", "MFA required?"],
		});

		expect(result.round).toBe(1);
		expect(result.status).toBe("in_progress");
		expect(result.analysis).toBe(
			"Initial analysis: user authentication needed",
		);
		expect(result.openQuestions).toEqual([
			"What auth provider?",
			"MFA required?",
		]);
	});

	test("refine increments round and incorporates responses", async () => {
		const repoRoot = `/tmp/pi-ce-bd-refine-${Date.now()}`;
		const tool = createBrainstormDialogTool();

		await tool.execute({
			operation: "start",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Initial analysis",
			questions: ["What auth provider?"],
		});

		const result = await tool.execute({
			operation: "refine",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Refined analysis: OAuth2 with Google",
			questions: ["Session timeout preference?"],
			userResponses: ["Google OAuth2"],
		});

		expect(result.round).toBe(2);
		expect(result.status).toBe("in_progress");
		expect(result.analysis).toBe("Refined analysis: OAuth2 with Google");
		expect(result.openQuestions).toEqual(["Session timeout preference?"]);
	});

	test("summarize marks dialog as complete", async () => {
		const repoRoot = `/tmp/pi-ce-bd-summarize-${Date.now()}`;
		const tool = createBrainstormDialogTool();

		await tool.execute({
			operation: "start",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Initial",
			questions: ["Q1?"],
		});

		const result = await tool.execute({
			operation: "summarize",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Final: OAuth2 with Google, 30min timeout",
		});

		expect(result.round).toBe(1);
		expect(result.status).toBe("complete");
		expect(result.analysis).toBe("Final: OAuth2 with Google, 30min timeout");
		expect(result.openQuestions).toEqual([]);
	});

	test("start on existing dialog returns current state", async () => {
		const repoRoot = `/tmp/pi-ce-bd-restart-${Date.now()}`;
		const tool = createBrainstormDialogTool();

		await tool.execute({
			operation: "start",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Initial",
			questions: ["Q1?"],
		});

		await tool.execute({
			operation: "refine",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
			analysis: "Refined",
			questions: ["Q2?"],
			userResponses: ["A1"],
		});

		const result = await tool.execute({
			operation: "start",
			repoRoot,
			artifactPath: "docs/brainstorms/2026-04-18-auth-requirements.md",
		});

		expect(result.round).toBe(2);
		expect(result.status).toBe("in_progress");
		expect(result.analysis).toBe("Refined");
	});

	test("rejects unknown operations", async () => {
		const tool = createBrainstormDialogTool();

		await expect(
			tool.execute({
				operation: "unknown" as any,
				repoRoot: "/tmp/test",
				artifactPath: "docs/test.md",
			}),
		).rejects.toThrow("Unknown operation");
	});
});

describe("plan_diff", () => {
	const existingUnits = [
		{
			name: "Unit 1: auth",
			description: "Add auth module",
			files: ["src/auth.ts"],
		},
		{
			name: "Unit 2: user API",
			description: "Add user endpoints",
			files: ["src/user.ts"],
		},
		{
			name: "Unit 3: tests",
			description: "Write tests",
			files: ["tests/auth.test.ts"],
		},
	];

	test("compare detects added, removed, modified, unchanged units", () => {
		const tool = createPlanDiffTool();

		const result = tool.execute({
			operation: "compare",
			existingUnits,
			newRequirements: [
				{
					name: "Unit 1: auth",
					description: "Add auth module with OAuth2",
					files: ["src/auth.ts", "src/oauth.ts"],
				},
				{
					name: "Unit 2: user API",
					description: "Add user endpoints",
					files: ["src/user.ts"],
				},
				{
					name: "Unit 4: docs",
					description: "Add API docs",
					files: ["docs/api.md"],
				},
			],
		});

		if (result.operation !== "compare")
			throw new Error("Expected compare result");
		expect(result.added.length).toBe(1);
		expect(result.added[0].name).toBe("Unit 4: docs");
		expect(result.removed.length).toBe(1);
		expect(result.removed[0].name).toBe("Unit 3: tests");
		expect(result.modified.length).toBe(1);
		expect(result.modified[0].name).toBe("Unit 1: auth");
		expect(result.unchanged.length).toBe(1);
		expect(result.unchanged[0].name).toBe("Unit 2: user API");
	});

	test("compare with identical inputs returns all unchanged", () => {
		const tool = createPlanDiffTool();

		const result = tool.execute({
			operation: "compare",
			existingUnits,
			newRequirements: existingUnits,
		});

		if (result.operation !== "compare")
			throw new Error("Expected compare result");
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(result.modified).toEqual([]);
		expect(result.unchanged.length).toBe(3);
	});

	test("patch applies changes and returns merged result", () => {
		const tool = createPlanDiffTool();

		const result = tool.execute({
			operation: "patch",
			existingUnits,
			changes: [
				{
					action: "modify",
					name: "Unit 1: auth",
					description: "Add OAuth2",
					files: ["src/auth.ts", "src/oauth.ts"],
				},
				{ action: "remove", name: "Unit 3: tests" },
				{
					action: "add",
					name: "Unit 4: docs",
					description: "API docs",
					files: ["docs/api.md"],
				},
			],
		});

		if (result.operation !== "patch") throw new Error("Expected patch result");
		expect(result.units.length).toBe(3);
		const names = result.units.map((u: { name: string }) => u.name);
		expect(names).toContain("Unit 1: auth");
		expect(names).toContain("Unit 2: user API");
		expect(names).toContain("Unit 4: docs");
		expect(names).not.toContain("Unit 3: tests");
		expect(result.appliedChanges).toBe(3);
	});

	test("rejects unknown operations", () => {
		const tool = createPlanDiffTool();

		expect(() =>
			tool.execute({
				operation: "unknown" as any,
				existingUnits: [],
				newRequirements: [],
			}),
		).toThrow("Unknown operation");
	});
});

describe("session_history", () => {
	const {
		_resetCounter,
	} = require("../extensions/ce-core/tools/session-history");
	_resetCounter();

	test("record logs an execution and query returns it", async () => {
		const repoRoot = `/tmp/pi-ce-sh-record-${Date.now()}`;
		const tool = createSessionHistoryTool();

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-brainstorm",
			artifactPath: "docs/brainstorms/auth-requirements.md",
			summary: "Discovered auth requirements",
		});

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-plan",
			artifactPath: "docs/plans/auth-plan.md",
			summary: "Created auth implementation plan",
		});

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-brainstorm",
			artifactPath: "docs/brainstorms/payment-requirements.md",
			summary: "Discovered payment requirements",
		});

		const result = await tool.execute({
			operation: "query",
			repoRoot,
			skill: "ce-brainstorm",
		});

		expect(result.entries.length).toBe(2);
		expect(
			result.entries.every(
				(e: { skill: string }) => e.skill === "ce-brainstorm",
			),
		).toBe(true);
	});

	test("latest returns most recent per skill", async () => {
		const repoRoot = `/tmp/pi-ce-sh-latest-${Date.now()}`;
		const tool = createSessionHistoryTool();

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-work",
			artifactPath: "docs/plans/auth-plan.md",
			summary: "Executed unit 1",
		});

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-work",
			artifactPath: "docs/plans/auth-plan.md",
			summary: "Executed unit 2",
		});

		const result = await tool.execute({
			operation: "latest",
			repoRoot,
		});

		expect(result.entries.length).toBe(1);
		expect(result.entries[0].skill).toBe("ce-work");
		expect(result.entries[0].summary).toBe("Executed unit 2");
	});

	test("query with no skill returns all entries", async () => {
		const repoRoot = `/tmp/pi-ce-sh-all-${Date.now()}`;
		const tool = createSessionHistoryTool();

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-brainstorm",
			artifactPath: "docs/brainstorms/a.md",
			summary: "Brainstorm A",
		});

		await tool.execute({
			operation: "record",
			repoRoot,
			skill: "ce-plan",
			artifactPath: "docs/plans/b.md",
			summary: "Plan B",
		});

		const result = await tool.execute({
			operation: "query",
			repoRoot,
		});

		expect(result.entries.length).toBe(2);
	});

	test("rejects unknown operations", async () => {
		const tool = createSessionHistoryTool();

		await expect(
			tool.execute({
				operation: "unknown" as any,
				repoRoot: "/tmp/test",
				skill: "ce-work",
			}),
		).rejects.toThrow("Unknown operation");
	});
});

describe("pattern_extractor", () => {
	test("extract identifies recurring patterns from artifacts", () => {
		const tool = createPatternExtractorTool();

		const result = tool.execute({
			operation: "extract",
			artifacts: [
				{
					path: "docs/brainstorms/auth.md",
					content: "Use OAuth2 for authentication. Need token refresh.",
				},
				{
					path: "docs/brainstorms/api.md",
					content: "Use OAuth2 for API auth. Token refresh needed.",
				},
				{
					path: "docs/brainstorms/docs.md",
					content: "Add API documentation using markdown.",
				},
			],
			keywords: ["OAuth2", "token", "API"],
		});

		if (result.operation !== "extract")
			throw new Error("Expected extract result");
		expect(result.patterns.length).toBeGreaterThanOrEqual(1);
		const oauthPattern = result.patterns.find(
			(p: { keyword: string }) => p.keyword === "OAuth2",
		);
		expect(oauthPattern).toBeTruthy();
		expect(oauthPattern!.occurrences).toBe(2);
		expect(oauthPattern!.sources.length).toBe(2);
	});

	test("extract with no keywords extracts all word frequencies", () => {
		const tool = createPatternExtractorTool();

		const result = tool.execute({
			operation: "extract",
			artifacts: [{ path: "a.md", content: "test test test unit test" }],
		});

		if (result.operation !== "extract")
			throw new Error("Expected extract result");
		expect(result.patterns.length).toBeGreaterThan(0);
	});

	test("categorize groups patterns by type", () => {
		const tool = createPatternExtractorTool();

		const result = tool.execute({
			operation: "categorize",
			patterns: [
				{
					keyword: "OAuth2",
					occurrences: 3,
					sources: ["a.md", "b.md", "c.md"],
				},
				{ keyword: "JWT", occurrences: 2, sources: ["a.md", "b.md"] },
				{ keyword: "database", occurrences: 1, sources: ["c.md"] },
			],
			categories: {
				auth: ["OAuth2", "JWT", "token", "authentication"],
				infra: ["database", "cache", "queue"],
			},
		});

		if (result.operation !== "categorize")
			throw new Error("Expected categorize result");
		expect(result.categories["auth"].length).toBe(2);
		expect(result.categories["infra"].length).toBe(1);
		expect(result.uncategorized.length).toBe(0);
	});

	test("categorize puts unmatched patterns in uncategorized", () => {
		const tool = createPatternExtractorTool();

		const result = tool.execute({
			operation: "categorize",
			patterns: [
				{ keyword: "OAuth2", occurrences: 1, sources: ["a.md"] },
				{ keyword: "unknown", occurrences: 1, sources: ["b.md"] },
			],
			categories: {
				auth: ["OAuth2"],
			},
		});

		if (result.operation !== "categorize")
			throw new Error("Expected categorize result");
		expect(result.categories["auth"].length).toBe(1);
		expect(result.uncategorized.length).toBe(1);
		expect(result.uncategorized[0].keyword).toBe("unknown");
	});

	test("rejects unknown operations", () => {
		const tool = createPatternExtractorTool();

		expect(() =>
			tool.execute({ operation: "unknown" as any, artifacts: [] }),
		).toThrow("Unknown operation");
	});
});

