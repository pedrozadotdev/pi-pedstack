import { describe, expect, test, mock } from "bun:test";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// Allow the test body to override the findings payload each test emits.
const mockState: { findings: unknown[] } = { findings: [] };

mock.module("node:child_process", () => {
	return {
		spawn: (_command: string, _args: string[], _options: any) => {
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

	test("does not create a findings file when no findings are produced", async () => {
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
			expect(result.findingsPath).toBeUndefined();
			expect(result.findingsRelativePath).toBeUndefined();

			const findingsDir = path.join(
				repoRoot,
				".context",
				"compound-engineering",
				"review-findings",
			);
			if (existsSync(findingsDir)) {
				const files = await readdir(findingsDir);
				expect(files).toEqual([]);
			}

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
