import { describe, expect, test, mock } from "bun:test";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// Allow the test body to override the findings payload each test emits.
const mockState: { findings: unknown[]; spawnArgs: string[][] } = {
	findings: [],
	spawnArgs: [],
};

mock.module("node:child_process", () => {
	return {
		spawn: (_command: string, _args: string[], _options: any) => {
			mockState.spawnArgs.push(_args);
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
					on: (_event: string, _cb: Function) => {
						// no-op for tests
					},
				},
				on: (event: string, cb: Function) => {
					listeners[event] = listeners[event] || [];
					listeners[event].push(cb);
				},
			};

			setTimeout(() => {
				const textPayload = JSON.stringify(mockState.findings);
				const messageEvent = {
					type: "message_end",
					message: {
						content: [
							{
								type: "text",
								text: "```json\n" + textPayload + "\n```",
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

import { createMultiReviewerTool } from "../extensions/ce-core/tools/multi-reviewer";

function spawnedModels(): string[] {
	return mockState.spawnArgs
		.map((args) => {
			const index = args.indexOf("--model");
			return index >= 0 ? args[index + 1] : undefined;
		})
		.filter((model): model is string => typeof model === "string");
}

function resetSpawnArgs(): void {
	mockState.spawnArgs.length = 0;
}

async function writeConfig(repoRoot: string, payload: Record<string, unknown>) {
	await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
	await writeFile(
		path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
		JSON.stringify(payload),
		"utf8",
	);
}

async function listRepoRootJsonFiles(repoRoot: string): Promise<string[]> {
	try {
		const files = await readdir(repoRoot);
		return files.filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
}

describe("multi_reviewer findings persistence", () => {
	test("persists findings JSON inside .context/compound-engineering/review-findings/", async () => {
		mockState.findings = [
			{
				severity: "high",
				summary: "Cmd exceeds 50-line limit",
				evidence: "L764-846",
				recommendedAction: "Extract helpers",
				reviewer: "Reviewer #1 (test)",
				autofixable: false,
			},
		];

		const repoRoot = `/tmp/pi-ce-reviewer-persist-${Date.now()}`;
		await writeConfig(repoRoot, {
			review: {
				model: "anthropic/claude-3-opus",
				thinkingLevel: "high",
				reviewers: [
					{ model: "anthropic/claude-3-opus", thinkingLevel: "high" },
				],
			},
		});

		try {
			const tool = createMultiReviewerTool();
			const result = await tool.execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			// The tool must report where it wrote the file.
			expect(result.findingsPath).toBeDefined();
			expect(result.findingsRelativePath).toBeDefined();

			// Relative path must live inside .context/ so it is gitignored.
			const relative = result.findingsRelativePath!;
			expect(relative.startsWith(".context/")).toBe(true);
			expect(relative).toContain("/review-findings/");
			expect(relative.endsWith(".json")).toBe(true);

			// Absolute path must match the relative one anchored at repoRoot.
			expect(result.findingsPath).toBe(path.join(repoRoot, relative));

			// File must exist on disk.
			expect(existsSync(result.findingsPath!)).toBe(true);

			// File must contain a parseable JSON payload with the findings.
			const onDisk = JSON.parse(await readFile(result.findingsPath!, "utf8"));
			expect(onDisk.stepName).toBe("04-review");
			expect(onDisk.count).toBe(1);
			expect(onDisk.findings).toHaveLength(1);
			expect(onDisk.findings[0].summary).toBe("Cmd exceeds 50-line limit");
			expect(onDisk.compiledSummary).toContain("🔴 High Severity");

			// Critical: nothing must leak to the repo root.
			const rootJsonFiles = await listRepoRootJsonFiles(repoRoot);
			expect(rootJsonFiles).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("persists an empty sidecar when a reviewer runs and finds nothing", async () => {
		mockState.findings = [];

		const repoRoot = `/tmp/pi-ce-reviewer-empty-${Date.now()}`;
		await writeConfig(repoRoot, {
			review: {
				model: "anthropic/claude-3-opus",
				thinkingLevel: "high",
				reviewers: [
					{ model: "anthropic/claude-3-opus", thinkingLevel: "high" },
				],
			},
		});

		try {
			const tool = createMultiReviewerTool();
			const result = await tool.execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(result.findings).toEqual([]);

			// A reviewer ran, so the clean result is auditable: both path fields
			// are present and the sidecar is a well-formed empty success.
			expect(result.findingsPath).toBeDefined();
			expect(result.findingsRelativePath).toBeDefined();
			expect(result.findingsRelativePath!.startsWith(".context/")).toBe(true);
			expect(existsSync(result.findingsPath!)).toBe(true);

			const onDisk = JSON.parse(await readFile(result.findingsPath!, "utf8"));
			expect(onDisk.count).toBe(0);
			expect(onDisk.findings).toEqual([]);

			const findingsDir = path.join(
				repoRoot,
				".context",
				"compound-engineering",
				"review-findings",
			);
			const files = await readdir(findingsDir);
			expect(files).toHaveLength(1);

			// And of course nothing leaked to the root.
			const rootJsonFiles = await listRepoRootJsonFiles(repoRoot);
			expect(rootJsonFiles).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("does not create a findings file when no reviewers are configured", async () => {
		mockState.findings = [];

		const repoRoot = `/tmp/pi-ce-reviewer-noconfig-${Date.now()}`;
		await writeConfig(repoRoot, {
			review: {
				model: "anthropic/claude-3-opus",
				thinkingLevel: "high",
				reviewers: [],
			},
		});

		try {
			const tool = createMultiReviewerTool();
			const result = await tool.execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(result.findings).toEqual([]);
			expect(result.compiledSummary).toBe("No reviewers configured.");
			expect(result.findingsPath).toBeUndefined();
			expect(result.findingsRelativePath).toBeUndefined();

			const rootJsonFiles = await listRepoRootJsonFiles(repoRoot);
			expect(rootJsonFiles).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});

describe("multi_reviewer role fallback", () => {
	test("uses models.review when no reviewers[] are configured", async () => {
		mockState.findings = [];
		resetSpawnArgs();

		const repoRoot = `/tmp/pi-ce-reviewer-role-${Date.now()}`;
		await writeConfig(repoRoot, {
			models: {
				default: { model: "exec/cheap" },
				review: { model: "review/distinct", thinkingLevel: "high" },
			},
		});

		try {
			const result = await createMultiReviewerTool().execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(spawnedModels()).toEqual(["review/distinct"]);
			expect(result.compiledSummary).not.toBe("No reviewers configured.");
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("defaults a missing review thinkingLevel to high", async () => {
		mockState.findings = [];
		resetSpawnArgs();

		const repoRoot = `/tmp/pi-ce-reviewer-thinking-${Date.now()}`;
		await writeConfig(repoRoot, {
			models: { review: { model: "review/distinct" } },
		});

		try {
			await createMultiReviewerTool().execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			const args = mockState.spawnArgs[0];
			const thinkingIndex = args.indexOf("--thinking");
			expect(thinkingIndex).toBeGreaterThanOrEqual(0);
			expect(args[thinkingIndex + 1]).toBe("high");
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("ignores models.review when it collides with an execution model", async () => {
		mockState.findings = [];
		resetSpawnArgs();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((arg) => String(arg)).join(" "));
		};

		const repoRoot = `/tmp/pi-ce-reviewer-collision-${Date.now()}`;
		await writeConfig(repoRoot, {
			models: {
				default: { model: "exec/cheap" },
				review: { model: "exec/cheap", thinkingLevel: "high" },
			},
		});

		try {
			const result = await createMultiReviewerTool().execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(spawnedModels()).toEqual([]);
			expect(result.compiledSummary).toBe("No reviewers configured.");
			expect(warnings.some((w) => w.includes("models.review"))).toBe(true);
		} finally {
			console.warn = originalWarn;
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("explicit reviewers[] wins over models.review", async () => {
		mockState.findings = [];
		resetSpawnArgs();

		const repoRoot = `/tmp/pi-ce-reviewer-explicit-${Date.now()}`;
		await writeConfig(repoRoot, {
			review: {
				model: "stage/model",
				thinkingLevel: "high",
				reviewers: [{ model: "explicit/reviewer", thinkingLevel: "high" }],
			},
			models: {
				default: { model: "exec/cheap" },
				review: { model: "role/reviewer", thinkingLevel: "high" },
			},
		});

		try {
			await createMultiReviewerTool().execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(spawnedModels()).toEqual(["explicit/reviewer"]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("no models.review keeps the unchanged no-reviewers path", async () => {
		mockState.findings = [];
		resetSpawnArgs();

		const repoRoot = `/tmp/pi-ce-reviewer-none-${Date.now()}`;
		await writeConfig(repoRoot, {
			models: { default: { model: "exec/cheap" } },
		});

		try {
			const result = await createMultiReviewerTool().execute({
				stepName: "04-review",
				primaryOutput: "const x = 1",
				repoRoot,
			});

			expect(result.compiledSummary).toBe("No reviewers configured.");
			expect(spawnedModels()).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
