// Unit 3: multi_reviewer mode selector + independence comparison set (RED first).
import { describe, expect, test, mock } from "bun:test";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

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
						content: [{ type: "text", text: "```json\n" + textPayload + "\n```" }],
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

function spawnedThinking(): (string | undefined)[] {
	return mockState.spawnArgs.map((args) => {
		const index = args.indexOf("--thinking");
		return index >= 0 ? args[index + 1] : undefined;
	});
}

async function writeConfig(repoRoot: string, payload: Record<string, unknown>) {
	await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
	await writeFile(
		path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
		JSON.stringify(payload),
		"utf8",
	);
}

async function withRepo(
	config: Record<string, unknown>,
	run: (repoRoot: string) => Promise<void>,
): Promise<void> {
	mockState.findings = [];
	mockState.spawnArgs.length = 0;
	const repoRoot = `/tmp/pi-ce-reviewer-mode-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	await writeConfig(repoRoot, config);
	try {
		await run(repoRoot);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
}

describe("multi_reviewer mode selector (Unit 3)", () => {
	test("single spawns exactly one reviewer when two explicit reviewers are configured", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/model",
					thinkingLevel: "high",
					reviewers: [
						{ model: "explicit/one", thinkingLevel: "high" },
						{ model: "explicit/two", thinkingLevel: "high" },
					],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
					mode: "single",
				});
				expect(spawnedModels()).toEqual(["explicit/one"]);
			},
		);
	});

	test("deep spawns both explicit reviewers", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/model",
					thinkingLevel: "high",
					reviewers: [
						{ model: "explicit/one", thinkingLevel: "high" },
						{ model: "explicit/two", thinkingLevel: "high" },
					],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
					mode: "deep",
				});
				expect(spawnedModels()).toEqual(["explicit/one", "explicit/two"]);
			},
		);
	});

	test("omitted mode still spawns all explicit reviewers (legacy)", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/model",
					thinkingLevel: "high",
					reviewers: [
						{ model: "explicit/one", thinkingLevel: "high" },
						{ model: "explicit/two", thinkingLevel: "high" },
					],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedModels()).toEqual(["explicit/one", "explicit/two"]);
			},
		);
	});

	test("models.review distinct from every execution model still spawns one reviewer", async () => {
		await withRepo(
			{
				plan: { model: "stage/plan" },
				models: {
					default: { model: "role/default" },
					review: { model: "role/review", thinkingLevel: "high" },
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedModels()).toEqual(["role/review"]);
			},
		);
	});

	test("models.review may reuse the per-stage execution model", async () => {
		await withRepo(
			{
				plan: { model: "stage/plan" },
				models: { review: { model: "stage/plan", thinkingLevel: "high" } },
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedModels()).toEqual(["stage/plan"]);
			},
		);
	});

	test("models.review may reuse the SOTA model", async () => {
		await withRepo(
			{
				models: {
					default: { model: "role/default" },
					review: { model: "role/sota", thinkingLevel: "max" },
					sota: { model: "role/sota", thinkingLevel: "max" },
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
					mode: "single",
				});
				expect(spawnedModels()).toEqual(["role/sota"]);
				expect(spawnedThinking()).toEqual(["max"]);
			},
		);
	});
});

describe("multi_reviewer isolated invocation semantics (Unit 3)", () => {
	test("keeps explicit reviewers that reuse the execution model", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/plan",
					reviewers: [
						{ model: "stage/plan", thinkingLevel: "high" },
						{ model: "explicit/one", thinkingLevel: "high" },
					],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
					mode: "deep",
				});
				expect(spawnedModels()).toEqual(["stage/plan", "explicit/one"]);
			},
		);
	});
});

describe("multi_reviewer thinkingLevel passthrough (Unit 4)", () => {
	test("passes an explicit reviewer thinkingLevel through unchanged", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/plan",
					reviewers: [{ model: "explicit/one", thinkingLevel: "low" }],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedThinking()).toEqual(["low"]);
			},
		);
	});

	test("omits --thinking when an explicit reviewer does not set a level", async () => {
		await withRepo(
			{
				plan: {
					model: "stage/plan",
					reviewers: [{ model: "explicit/one" }],
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedThinking()).toEqual([undefined]);
			},
		);
	});

	test("keeps the high default for the models.review role", async () => {
		await withRepo(
			{
				plan: { model: "stage/plan" },
				models: {
					default: { model: "role/default" },
					review: { model: "role/review" },
				},
			},
			async (repoRoot) => {
				await createMultiReviewerTool().execute({
					stepName: "02-plan",
					primaryOutput: "const x = 1",
					repoRoot,
				});
				expect(spawnedThinking()).toEqual(["high"]);
			},
		);
	});
});
