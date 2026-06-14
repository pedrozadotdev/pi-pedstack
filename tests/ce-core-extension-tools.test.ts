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

import ceCoreExtension from "../extensions/ce-core/index";
import {
	getBrainstormArtifactPath,
	getPlanArtifactPath,
	getSolutionArtifactPath,
	getRunArtifactPath,
} from "../extensions/ce-core/utils/artifact-paths";
import { createArtifactHelperTool } from "../extensions/ce-core/tools/artifact-helper";
import { createWorkflowStateTool } from "../extensions/ce-core/tools/workflow-state";
import { createReviewRouterTool } from "../extensions/ce-core/tools/review-router";
import { createSessionCheckpointTool } from "../extensions/ce-core/tools/session-checkpoint";
import { normalizeSlug } from "../extensions/ce-core/utils/name-utils";

describe("artifact paths", () => {
	const repoRoot = "/tmp/pi-ce-repo";

	test("builds the brainstorm artifact path", () => {
		expect(
			getBrainstormArtifactPath(repoRoot, "2026-04-17", "Pi CE Package"),
		).toBe(
			path.join(
				repoRoot,
				"docs",
				"brainstorms",
				"2026-04-17-pi-ce-package-requirements.md",
			),
		);
	});

	test("builds the plan artifact path", () => {
		expect(getPlanArtifactPath(repoRoot, "2026-04-17", "Pi CE Package")).toBe(
			path.join(repoRoot, "docs", "plans", "2026-04-17-pi-ce-package-plan.md"),
		);
	});

	test("builds the solution artifact path by category", () => {
		expect(
			getSolutionArtifactPath(
				repoRoot,
				"workflow",
				"package bootstrap",
				"2026-04-17",
			),
		).toBe(
			path.join(
				repoRoot,
				"docs",
				"solutions",
				"workflow",
				"2026-04-17-package-bootstrap.md",
			),
		);
	});

	test("builds the run artifact path", () => {
		expect(getRunArtifactPath(repoRoot, "ce-review", "run-001")).toBe(
			path.join(
				repoRoot,
				".context",
				"compound-engineering",
				"ce-review",
				"run-001",
			),
		);
	});
});

describe("slug normalization", () => {
	test("normalizes mixed-case and punctuation-heavy labels", () => {
		expect(normalizeSlug("Pi CE: Package! Design")).toBe(
			"pi-ce-package-design",
		);
	});

	test("collapses repeated separators and trims edges", () => {
		expect(normalizeSlug("---Brainstorm___Plan---")).toBe("brainstorm-plan");
	});
});

describe("artifact_helper", () => {
	test("suggests a brainstorm artifact path", async () => {
		const tool = createArtifactHelperTool();
		const result = await tool.execute({
			repoRoot: "/tmp/pi-ce-repo",
			artifactType: "brainstorm",
			date: "2026-04-17",
			topic: "Pi CE Package",
		});

		expect(result.path).toBe(
			path.normalize(
				"/tmp/pi-ce-repo/docs/brainstorms/2026-04-17-pi-ce-package-requirements.md",
			),
		);
		expect(result.createdDirectories).toEqual([]);
	});

	test("creates missing directories for a solution artifact", async () => {
		const repoRoot = "/tmp/pi-ce-artifact-helper";
		const tool = createArtifactHelperTool();

		const result = await tool.execute({
			repoRoot,
			artifactType: "solution",
			date: "2026-04-17",
			topic: "Package Bootstrap",
			category: "workflow",
			ensureDir: true,
		});

		expect(result.path).toBe(
			path.normalize(
				"/tmp/pi-ce-artifact-helper/docs/solutions/workflow/2026-04-17-package-bootstrap.md",
			),
		);
		expect(result.createdDirectories).toContain(
			path.normalize("/tmp/pi-ce-artifact-helper/docs/solutions/workflow"),
		);
	});

	test("creates the run artifact directory when ensureDir is true", async () => {
		const repoRoot = "/tmp/pi-ce-run-artifact";
		const tool = createArtifactHelperTool();

		const result = await tool.execute({
			repoRoot,
			artifactType: "run",
			skillName: "ce-review",
			runId: "run-001",
			ensureDir: true,
		});

		expect(result.path).toBe(
			path.normalize(
				"/tmp/pi-ce-run-artifact/.context/compound-engineering/ce-review/run-001",
			),
		);
		expect(result.createdDirectories).toContain(
			path.normalize(
				"/tmp/pi-ce-run-artifact/.context/compound-engineering/ce-review",
			),
		);
	});

	test("does not create directories when ensureDir is false or absent", async () => {
		const tool = createArtifactHelperTool();

		const result = await tool.execute({
			repoRoot: "/tmp/pi-ce-no-dir",
			artifactType: "brainstorm",
			date: "2026-04-17",
			topic: "Test",
			ensureDir: false,
		});

		expect(result.path).toBe(
			path.normalize(
				"/tmp/pi-ce-no-dir/docs/brainstorms/2026-04-17-test-requirements.md",
			),
		);
		expect(result.createdDirectories).toEqual([]);
	});
});

describe("workflow_state", () => {
	test("reports empty state when no artifacts exist", async () => {
		const tool = createWorkflowStateTool();
		const result = await tool.execute({
			repoRoot: "/tmp/pi-ce-empty-repo-" + Date.now(),
		});

		expect(result.brainstorms.count).toBe(0);
		expect(result.plans.count).toBe(0);
		expect(result.reviews.count).toBe(0);
		expect(result.solutions.count).toBe(0);
		expect(result.runs.count).toBe(0);
		expect(result.brainstorms.latest).toBeNull();
		expect(result.plans.latest).toBeNull();
		expect(result.reviews.latest).toBeNull();
		expect(result.solutions.latest).toBeNull();
		expect(result.runs.latest).toBeNull();
	});

	test("reports brainstorm count and latest when artifacts exist", async () => {
		const repoRoot = "/tmp/pi-ce-ws-brainstorm";
		const brainstormDir = path.join(repoRoot, "docs", "brainstorms");
		await mkdir(brainstormDir, { recursive: true });
		await writeFile(
			path.join(brainstormDir, "2026-04-17-test-requirements.md"),
			"content",
		);

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.brainstorms.count).toBe(1);
		expect(result.brainstorms.latest).toBe("2026-04-17-test-requirements.md");
		expect(result.plans.count).toBe(0);
		expect(result.reviews.count).toBe(0);
	});

	test("reports solutions recursively across subcategories", async () => {
		const repoRoot = "/tmp/pi-ce-ws-solutions";
		const solDir = path.join(repoRoot, "docs", "solutions", "integration");
		await mkdir(solDir, { recursive: true });
		await writeFile(path.join(solDir, "2026-04-17-npm-publish.md"), "content");

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.solutions.count).toBe(1);
		expect(result.solutions.latest).toContain("npm-publish");
	});

	test("picks the most recent artifact as latest", async () => {
		const repoRoot = "/tmp/pi-ce-ws-multi";
		const planDir = path.join(repoRoot, "docs", "plans");
		await mkdir(planDir, { recursive: true });
		await writeFile(path.join(planDir, "2026-04-16-old-plan.md"), "old");
		await writeFile(path.join(planDir, "2026-04-17-new-plan.md"), "new");

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.plans.count).toBe(2);
		expect(result.plans.latest).toBe("2026-04-17-new-plan.md");
	});

	// --- Unit 3: workflow_state.context runtime-state discovery ---

	test("context returns safe empty state when no context-state.json exists", async () => {
		const tool = createWorkflowStateTool();
		const result = await tool.execute({
			repoRoot: `/tmp/pi-ce-ws-no-context-${Date.now()}`,
		});

		expect(result.context).toBeDefined();
		expect(result.context.found).toBe(false);
		expect(result.context.currentTruth).toEqual([]);
		expect(result.context.invalidatedAssumptions).toEqual([]);
		expect(result.context.openDecisions).toEqual([]);
		expect(result.context.recentlyAccessedFiles).toEqual([]);
		expect(result.context.compressionRisk).toEqual([]);
	});

	test("context reads structured fields from context-state.json", async () => {
		const repoRoot = `/tmp/pi-ce-ws-ctx-${Date.now()}`;
		const ctxDir = path.join(repoRoot, ".context", "compound-engineering");
		await mkdir(ctxDir, { recursive: true });
		await writeFile(
			path.join(ctxDir, "context-state.json"),
			JSON.stringify({
				currentStage: "03-work",
				nextStage: "04-review",
				contextHealth: "watch",
				latestHandoffPath: ".context/compound-engineering/handoffs/latest.md",
				latestDatedHandoffPath:
					".context/compound-engineering/handoffs/2026-04-30.md",
				activeFiles: ["src/a.ts", "src/b.ts"],
				recentlyAccessedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
				blocker: "N/A",
				verification: "bun test passed",
				currentTruth: ["Fact A"],
				invalidatedAssumptions: ["Old assumption"],
				openDecisions: ["Decision X"],
				compressionRisk: ["Risk Z"],
				recommendNewSession: false,
				updatedAt: "2026-04-30T00:00:00.000Z",
			}),
		);

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.context.found).toBe(true);
		expect(result.context.currentStage).toBe("03-work");
		expect(result.context.nextStage).toBe("04-review");
		expect(result.context.contextHealth).toBe("watch");
		expect(result.context.latestHandoffPath).toBe(
			".context/compound-engineering/handoffs/latest.md",
		);
		expect(result.context.latestDatedHandoffPath).toBe(
			".context/compound-engineering/handoffs/2026-04-30.md",
		);
		expect(result.context.activeFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.context.recentlyAccessedFiles).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
		expect(result.context.blocker).toBe("N/A");
		expect(result.context.verification).toBe("bun test passed");
		expect(result.context.currentTruth).toEqual(["Fact A"]);
		expect(result.context.invalidatedAssumptions).toEqual(["Old assumption"]);
		expect(result.context.openDecisions).toEqual(["Decision X"]);
		expect(result.context.compressionRisk).toEqual(["Risk Z"]);
		expect(result.context.recommendNewSession).toBe(false);
		expect(result.context.updatedAt).toBe("2026-04-30T00:00:00.000Z");
	});

	test("context returns safe defaults for malformed context-state.json", async () => {
		const repoRoot = `/tmp/pi-ce-ws-ctx-malformed-${Date.now()}`;
		const ctxDir = path.join(repoRoot, ".context", "compound-engineering");
		await mkdir(ctxDir, { recursive: true });
		await writeFile(
			path.join(ctxDir, "context-state.json"),
			"NOT VALID JSON{{{",
		);

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.context.found).toBe(false);
		expect(result.context.currentTruth).toEqual([]);
		expect(result.context.activeFiles).toEqual([]);
	});

	test("context filters non-string array entries from context-state.json", async () => {
		const repoRoot = `/tmp/pi-ce-ws-ctx-array-filter-${Date.now()}`;
		const ctxDir = path.join(repoRoot, ".context", "compound-engineering");
		await mkdir(ctxDir, { recursive: true });
		await writeFile(
			path.join(ctxDir, "context-state.json"),
			JSON.stringify({
				currentStage: "03-work",
				activeFiles: ["src/a.ts", 42, null],
				recentlyAccessedFiles: ["src/b.ts", false],
				currentTruth: ["Fact A", { nope: true }],
				invalidatedAssumptions: ["Old assumption", 123],
				openDecisions: ["Decision X", []],
				compressionRisk: ["Risk Z", null],
			}),
		);

		const tool = createWorkflowStateTool();
		const result = await tool.execute({ repoRoot });

		expect(result.context.found).toBe(true);
		expect(result.context.activeFiles).toEqual(["src/a.ts"]);
		expect(result.context.recentlyAccessedFiles).toEqual(["src/b.ts"]);
		expect(result.context.currentTruth).toEqual(["Fact A"]);
		expect(result.context.invalidatedAssumptions).toEqual(["Old assumption"]);
		expect(result.context.openDecisions).toEqual(["Decision X"]);
		expect(result.context.compressionRisk).toEqual(["Risk Z"]);
	});
});

describe("review_router", () => {
	test("returns base reviewers for any non-empty diff", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: ["src/index.ts"],
			insertions: 10,
			deletions: 2,
		});

		const names = result.reviewers.map((r) => r.name);
		expect(names).toContain("correctness-reviewer");
		expect(names).toContain("testing-reviewer");
		expect(names).toContain("maintainability-reviewer");
		expect(result.reviewers.length).toBeGreaterThanOrEqual(3);
	});

	test("adds security reviewer when auth-related paths are changed", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: ["src/auth/login.ts", "src/middleware/permissions.ts"],
			insertions: 50,
			deletions: 10,
		});

		const names = result.reviewers.map((r) => r.name);
		expect(names).toContain("security-reviewer");
	});

	test("adds performance reviewer when data/query paths are changed", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: ["src/db/queries.ts", "src/cache/manager.ts"],
			insertions: 30,
			deletions: 5,
		});

		const names = result.reviewers.map((r) => r.name);
		expect(names).toContain("performance-reviewer");
	});

	test("adds integration reviewer when config or CI files change", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: [".github/workflows/test.yml", "package.json"],
			insertions: 15,
			deletions: 3,
		});

		const names = result.reviewers.map((r) => r.name);
		expect(names).toContain("integration-reviewer");
	});

	test("large diffs add thoroughness reviewer", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: [
				"src/core.ts",
				"src/utils.ts",
				"src/main.ts",
				"src/config.ts",
				"src/types.ts",
				"src/helpers.ts",
			],
			insertions: 500,
			deletions: 200,
		});

		const names = result.reviewers.map((r) => r.name);
		expect(names).toContain("thoroughness-reviewer");
	});

	test("each reviewer includes a reason", async () => {
		const tool = createReviewRouterTool();
		const result = await tool.execute({
			filesChanged: ["src/auth/token.ts"],
			insertions: 20,
			deletions: 5,
		});

		for (const reviewer of result.reviewers) {
			expect(reviewer.reason).toBeTruthy();
			expect(typeof reviewer.reason).toBe("string");
		}
	});
});

describe("session_checkpoint", () => {
	test("save creates a checkpoint file", async () => {
		const repoRoot = `/tmp/pi-ce-cp-save-${Date.now()}`;
		const tool = createSessionCheckpointTool();

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/2026-04-18-ci-cd-plan.md",
			completedUnits: ["Unit 1: test.yml", "Unit 2: publish.yml"],
		});

		const result = await tool.execute({
			operation: "load",
			repoRoot,
			planPath: "docs/plans/2026-04-18-ci-cd-plan.md",
		});

		expect(result.planPath).toBe("docs/plans/2026-04-18-ci-cd-plan.md");
		expect(result.completedUnits).toEqual([
			"Unit 1: test.yml",
			"Unit 2: publish.yml",
		]);
		expect(result.updatedAt).toBeTruthy();
	});

	test("load returns empty array when no checkpoint exists", async () => {
		const tool = createSessionCheckpointTool();

		const result = await tool.execute({
			operation: "load",
			repoRoot: `/tmp/pi-ce-cp-empty-${Date.now()}`,
			planPath: "docs/plans/nonexistent.md",
		});

		expect(result.completedUnits).toEqual([]);
	});

	test("save appends additional completed units", async () => {
		const repoRoot = `/tmp/pi-ce-cp-append-${Date.now()}`;
		const tool = createSessionCheckpointTool();

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/2026-04-18-ci-cd-plan.md",
			completedUnits: ["Unit 1"],
		});

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/2026-04-18-ci-cd-plan.md",
			completedUnits: ["Unit 1", "Unit 2", "Unit 3"],
		});

		const result = await tool.execute({
			operation: "load",
			repoRoot,
			planPath: "docs/plans/2026-04-18-ci-cd-plan.md",
		});

		expect(result.completedUnits).toEqual(["Unit 1", "Unit 2", "Unit 3"]);
	});

	test("list returns all checkpoints", async () => {
		const repoRoot = `/tmp/pi-ce-cp-list-${Date.now()}`;
		const tool = createSessionCheckpointTool();

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/plan-a.md",
			completedUnits: ["Unit 1"],
		});

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/plan-b.md",
			completedUnits: ["Unit 1", "Unit 2"],
		});

		const result = await tool.execute({
			operation: "list",
			repoRoot,
		});

		expect(result.checkpoints?.length).toBe(2);
		const paths = (result.checkpoints ?? []).map(
			(c: { planPath: string }) => c.planPath,
		);
		expect(paths).toContain("docs/plans/plan-a.md");
		expect(paths).toContain("docs/plans/plan-b.md");
	});

	test("rejects unknown operations", async () => {
		const tool = createSessionCheckpointTool();

		await expect(
			tool.execute({
				operation: "unknown" as any,
				repoRoot: "/tmp/test",
				planPath: "docs/plans/test.md",
			}),
		).rejects.toThrow("Unknown operation");
	});

	test("fail records error context on a checkpoint", async () => {
		const repoRoot = `/tmp/pi-ce-cp-fail-${Date.now()}`;
		const tool = createSessionCheckpointTool();

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/plan-a.md",
			completedUnits: ["Unit 1"],
		});

		const result = await tool.execute({
			operation: "fail",
			repoRoot,
			planPath: "docs/plans/plan-a.md",
			failedUnit: "Unit 2: auth module",
			error: "TypeError: Cannot read property 'token' of undefined",
		});

		expect(result.status).toBe("failed");
		expect(result.failedUnit).toBe("Unit 2: auth module");
		expect(result.error).toContain("TypeError");
		expect(result.completedUnits).toEqual(["Unit 1"]);
	});

	test("retry returns retry strategy for a failed checkpoint", async () => {
		const repoRoot = `/tmp/pi-ce-cp-retry-${Date.now()}`;
		const tool = createSessionCheckpointTool();

		await tool.execute({
			operation: "save",
			repoRoot,
			planPath: "docs/plans/plan-b.md",
			completedUnits: ["Unit 1", "Unit 2"],
		});

		await tool.execute({
			operation: "fail",
			repoRoot,
			planPath: "docs/plans/plan-b.md",
			failedUnit: "Unit 3",
			error: "Test timeout",
		});

		const result = await tool.execute({
			operation: "retry",
			repoRoot,
			planPath: "docs/plans/plan-b.md",
		});

		expect(result.status).toBe("retry");
		expect(result.retryFrom).toBe("Unit 3");
		expect(result.completedUnits).toEqual(["Unit 1", "Unit 2"]);
		expect(result.strategy).toBeTruthy();
	});
});

