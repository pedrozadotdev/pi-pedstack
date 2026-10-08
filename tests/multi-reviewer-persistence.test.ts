import { describe, expect, test, mock } from "bun:test";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// Allow the test body to override the findings payload each test emits.
const mockState: {
	findings: unknown[];
	spawnArgs: string[][];
	spawnCommands: string[];
	spawnOptions: Array<{ shell?: boolean | string }>;
	processMode: "success" | "nonzero" | "malformed" | "stall" | "stderr-heavy" | "oversized-stdout";
	stderrBytesDelivered: number;
	killSignals: string[];
} = {
	findings: [],
	spawnArgs: [],
	spawnCommands: [],
	spawnOptions: [],
	processMode: "success",
	stderrBytesDelivered: 0,
	killSignals: [],
};

mock.module("node:child_process", () => {
	return {
		spawn: (_command: string, _args: string[], _options: any) => {
			mockState.spawnArgs.push(_args);
			mockState.spawnCommands.push(_command);
			mockState.spawnOptions.push(_options);
			const listeners: Record<string, Function[]> = {};
			const stdoutListeners: Record<string, Function[]> = {};
			const stderrListeners: Record<string, Function[]> = {};

			const proc = {
				stdout: {
					on: (event: string, cb: Function) => {
						stdoutListeners[event] = stdoutListeners[event] || [];
						stdoutListeners[event].push(cb);
					},
				},
				stderr: {
					on: (event: string, cb: Function) => {
						stderrListeners[event] = stderrListeners[event] || [];
						stderrListeners[event].push(cb);
					},
				},
				on: (event: string, cb: Function) => {
					listeners[event] = listeners[event] || [];
					listeners[event].push(cb);
				},
				kill: (signal: string) => {
					mockState.killSignals.push(signal);
				},
			};

			setTimeout(() => {
				if (mockState.processMode === "stall") return;
				if (mockState.processMode === "nonzero") {
					for (const cb of listeners["close"] ?? []) cb(1);
					return;
				}
				if (mockState.processMode === "stderr-heavy") {
					const stderrChunk = Buffer.alloc(128 * 1024, 0x65);
					for (const cb of stderrListeners["data"] ?? []) {
						cb(stderrChunk);
						mockState.stderrBytesDelivered += stderrChunk.byteLength;
					}
				}
				const textPayload = mockState.processMode === "malformed"
					? "not a findings array"
					: JSON.stringify(mockState.findings);
				const messageEvent = {
					type: "message_end",
					message: {
						content: [
							{
								type: "text",
								text: mockState.processMode === "oversized-stdout"
									? "x".repeat(1024 * 1024 + 1)
									: "```json\n" + textPayload + "\n```",
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
	mockState.spawnCommands.length = 0;
	mockState.spawnOptions.length = 0;
	mockState.stderrBytesDelivered = 0;
	mockState.killSignals.length = 0;
}

function captureReviewerDeadline(): { fire: () => void; restore: () => void } {
	const originalSetTimeout = globalThis.setTimeout;
	let fireDeadline: (() => void) | undefined;
	globalThis.setTimeout = ((callback: unknown, delay?: number, ...args: unknown[]) => {
		if (delay === 120_000 && typeof callback === "function") {
			fireDeadline = () => callback(...args);
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}
		return Reflect.apply(originalSetTimeout, globalThis, [callback, delay, ...args]) as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	return {
		fire: () => {
			if (!fireDeadline) throw new Error("reviewer process deadline was not scheduled");
			fireDeadline();
		},
		restore: () => { globalThis.setTimeout = originalSetTimeout; },
	};
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

async function windowsPiFixture(run: (repoRoot: string, prefix: string, cli: string) => Promise<void>): Promise<void> {
	const repoRoot = `/tmp/pi-ce-windows-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const prefix = path.join(repoRoot, "npm prefix & spaces");
	const packageRoot = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
	const cli = path.join(packageRoot, "dist", "cli.js");
	await mkdir(path.dirname(cli), { recursive: true });
	await writeFile(cli, "// fixture Pi entrypoint\n");
	await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
	await writeFile(path.join(prefix, "pi.cmd"), "@node fixture-pi-cli %*\n");
	await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	const argv = process.argv;
	const oldPath = process.env.PATH;
	Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
	process.argv = [process.execPath]; // Generic runtime, with no existing Pi script.
	process.env.PATH = `${path.join(repoRoot, "missing prefix")};${prefix}`;
	mockState.findings = [];
	resetSpawnArgs();
	try { await run(repoRoot, prefix, cli); }
	finally {
		Object.defineProperty(process, "platform", descriptor);
		process.argv = argv;
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		await rm(repoRoot, { recursive: true, force: true });
	}
}

describe("multi_reviewer findings persistence", () => {
	test("launches a non-Gemini Windows npm Pi reviewer through its JS entrypoint without a shell", async () => {
		await windowsPiFixture(async (repoRoot, _prefix, cli) => {
			const material = "literal artifact & echo sentinel | %TOKEN% > target\nsecond line";
			const result = await createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: material, repoRoot });
			expect(result.findings).toEqual([]);
			expect(mockState.spawnCommands).toEqual([process.execPath]);
			expect(mockState.spawnArgs[0]?.[0]).toBe(cli);
			expect(mockState.spawnArgs[0]?.at(-1)).toBe(`Review the following artifact/work output:\n\n${material}`);
			expect(spawnedModels()).toEqual(["anthropic/claude-3-sonnet"]);
			expect(mockState.spawnOptions[0]?.shell).toBe(false);
		});
	});

	test("rejects an unresolvable Windows npm entrypoint instead of passing artifact text to cmd.exe", async () => {
		await windowsPiFixture(async (repoRoot, prefix) => {
			await rm(path.join(prefix, "node_modules"), { recursive: true, force: true });
			await expect(createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot })).rejects.toThrow("Review incomplete");
			expect(mockState.spawnCommands).toEqual([]);
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		});
	});

	test("retains a native Windows Pi executable without using the npm command shell", async () => {
		await windowsPiFixture(async (repoRoot, prefix) => {
			const executable = path.join(prefix, "pi.exe");
			await writeFile(executable, "fixture native executable");
			await createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot });
			expect(mockState.spawnCommands).toEqual([executable]);
			expect(mockState.spawnArgs[0]?.[0]).toBe("--mode");
			expect(mockState.spawnOptions[0]?.shell).toBe(false);
		});
	});

	test.each([
		JSON.stringify({ name: "other-package", bin: { pi: "dist/cli.js" } }),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../../outside.js" } }),
		"malformed manifest",
	])("rejects an unsupported Windows Pi npm manifest without launching a process: %s", async (manifest) => {
		await windowsPiFixture(async (repoRoot, prefix) => {
			await writeFile(path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), manifest);
			await expect(createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot })).rejects.toThrow("Review incomplete");
			expect(mockState.spawnCommands).toEqual([]);
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		});
	});

	test("retains direct script invocation on Windows when the current Pi script exists", async () => {
		await windowsPiFixture(async (repoRoot, _prefix, cli) => {
			process.argv = [process.execPath, cli];
			await createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot });
			expect(mockState.spawnCommands).toEqual([process.execPath]);
			expect(mockState.spawnArgs[0]?.[0]).toBe(cli);
			expect(mockState.spawnOptions[0]?.shell).toBe(false);
		});
	});
	test("does not persist a success sidecar when a reviewer process fails", async () => {
		mockState.processMode = "nonzero";
		const repoRoot = `/tmp/pi-ce-reviewer-failed-${Date.now()}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		try {
			await expect(createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "const x = 1", repoRoot })).rejects.toThrow();
			expect(await listRepoRootJsonFiles(repoRoot)).toEqual([]);
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		} finally {
			mockState.processMode = "success";
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("kills a stalled Pi reviewer at its deadline without writing a success sidecar", async () => {
		mockState.processMode = "stall";
		mockState.findings = [];
		resetSpawnArgs();
		const repoRoot = `/tmp/pi-ce-reviewer-stalled-${Date.now()}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		const deadline = captureReviewerDeadline();
		try {
			const pending = createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot });
			await Bun.sleep(20);
			expect(mockState.spawnArgs).toHaveLength(1);
			deadline.fire();
			let rejection: unknown;
			try {
				await pending;
			} catch (error) {
				rejection = error;
			}
			expect(rejection instanceof Error ? rejection.message : "").toContain("Review incomplete");
			expect(mockState.killSignals).toContain("SIGKILL");
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		} finally {
			deadline.restore();
			mockState.processMode = "success";
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("drains stderr beyond pipe capacity while keeping a valid Pi review successful", async () => {
		mockState.processMode = "stderr-heavy";
		mockState.findings = [];
		resetSpawnArgs();
		const repoRoot = `/tmp/pi-ce-reviewer-stderr-${Date.now()}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		try {
			const result = await createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot });
			expect(result.findings).toEqual([]);
			expect(mockState.stderrBytesDelivered).toBe(128 * 1024);
		} finally {
			mockState.processMode = "success";
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("kills an oversized Pi response and does not write a success sidecar", async () => {
		mockState.processMode = "oversized-stdout";
		mockState.findings = [];
		resetSpawnArgs();
		const repoRoot = `/tmp/pi-ce-reviewer-output-cap-${Date.now()}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		try {
			let rejection: unknown;
			try {
				await createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "artifact", repoRoot });
			} catch (error) {
				rejection = error;
			}
			expect(rejection instanceof Error ? rejection.message : "").toContain("output exceeded 1 MiB");
			expect(mockState.killSignals).toContain("SIGKILL");
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		} finally {
			mockState.processMode = "success";
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("rejects malformed reviewer findings instead of certifying an empty review", async () => {
		mockState.processMode = "malformed";
		const repoRoot = `/tmp/pi-ce-reviewer-malformed-${Date.now()}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		try {
			await expect(createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "const x = 1", repoRoot })).rejects.toThrow();
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		} finally {
			mockState.processMode = "success";
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
	test.each([
		["missing required fields", [{}]],
		["invalid severity after a valid finding", [
			{ severity: "low", summary: "Valid", evidence: "L1", recommendedAction: "Keep checking", autofixable: false },
			{ severity: "critical", summary: "Invalid", evidence: "L2", recommendedAction: "Fix severity", autofixable: false },
		]],
		["empty required evidence", [
			{ severity: "moderate", summary: "Missing evidence", evidence: "  ", recommendedAction: "Add evidence", autofixable: false },
		]],
	])("rejects Pi findings with %s before writing a success sidecar", async (_label, findings) => {
		mockState.processMode = "success";
		mockState.findings = findings;
		const repoRoot = `/tmp/pi-ce-reviewer-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		await writeConfig(repoRoot, { review: { model: "anthropic/claude-3-opus", reviewers: [{ model: "anthropic/claude-3-sonnet" }] } });
		try {
			await expect(createMultiReviewerTool().execute({ stepName: "04-review", primaryOutput: "const x = 1", repoRoot })).rejects.toThrow("Review incomplete");
			expect(existsSync(path.join(repoRoot, ".context", "compound-engineering", "review-findings"))).toBe(false);
		} finally {
			mockState.findings = [];
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

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
					{ model: "anthropic/claude-3-sonnet", thinkingLevel: "high" },
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
					{ model: "anthropic/claude-3-sonnet", thinkingLevel: "high" },
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

	test("uses models.review even when it reuses an execution model id", async () => {
		mockState.findings = [];
		resetSpawnArgs();

		const repoRoot = `/tmp/pi-ce-reviewer-reuse-${Date.now()}`;
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

			expect(spawnedModels()).toEqual(["exec/cheap"]);
			expect(result.compiledSummary).not.toBe("No reviewers configured.");
		} finally {
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
