import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";

mock.module("@earendil-works/pi-ai", () => {
	return {
		completeSimple: async (_model: any, _prompt: any, _options: any) => {
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

import { clearAutoAdvanceCache } from "../extensions/ce-core/utils/auto-advance";
import {
	clearActiveStage,
	getActiveStage,
	setActiveStage,
} from "../extensions/ce-core/utils/active-stage";
import { resetPedstackState } from "../extensions/ce-core/commands/pedstack";
import ceCoreExtension from "../extensions/ce-core/index";
import { createMultiReviewerTool } from "../extensions/ce-core/tools/multi-reviewer";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";
import { testFeatures } from "./helpers/feature-config";

const PLAN_FIXTURE = `# Plan: fixture

## Problem summary
${'Detailed problem context. '.repeat(40)}
## Implementation units

### Unit 1 — One
- **Files**
  - create \`src/a.ts\`
- **Verification:** \`bun test\`

## Verification
- RED then GREEN; Strict Review applied.
`;

describe("ce-core extension runtime registration", () => {
	afterEach(() => {
		setStartupFeaturesForTests(null);
	});

	function disableHandoffPolicyForWrapperContract(): void {
		setStartupFeaturesForTests(
			testFeatures({
				stageGate: { mode: "off" },
				handoffReadiness: { mode: "off" },
				docsVerification: { mode: "off" },
				driftGuard: { mode: "off" },
			}),
		);
	}

	test("registers 20 workflow control tools (no subagent tools)", () => {
		const registeredNames: string[] = [];
		const eventHandlers = new Map<string, any[]>();
		const pi = {
			registerTool(definition: { name: string }) {
				registeredNames.push(definition.name);
			},
			on(event: string, handler: any) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerCommand(_name: string, _def: any) {
				// no-op for tests
			},
		};

		ceCoreExtension(pi as never);

		expect(registeredNames).toEqual([
			"artifact_helper",
			"stage_report",
			"workflow_state",
			"review_router",
			"session_checkpoint",
			"task_splitter",
			"brainstorm_dialog",
			"plan_diff",
			"session_history",
			"pattern_extractor",
			"context_handoff",
			"stage_gate",
			"checklist_add",
			"checklist_show",
			"checklist_del",
			"multi_reviewer",
			"solution_search",
			"docs_verification",
			"semantic_read",
			"semantic_scout",
		]);
	});

	test("registers no bare subagent or parallel_subagent", () => {
		const registeredNames: string[] = [];
		const pi = {
			registerTool(definition: { name: string }) {
				registeredNames.push(definition.name);
			},
			on(_event: string, _handler: any) {},
			registerCommand(_name: string, _def: any) {},
		};

		ceCoreExtension(pi as never);

		// Subagent tools removed (Unit 1 guard)
		expect(registeredNames).not.toContain("subagent");
		expect(registeredNames).not.toContain("parallel_subagent");
		expect(registeredNames).not.toContain("ce_subagent");
		expect(registeredNames).not.toContain("ce_parallel_subagent");
	});

	test("brainstorm_dialog does not terminate the agent turn", async () => {
		const definitions = new Map<string, any>();
		const pi = {
			registerTool(definition: { name: string }) {
				definitions.set(definition.name, definition);
			},
			on(_event: string, _handler: any) {
				// no-op for tests
			},
			registerCommand(_name: string, _def: any) {
				// no-op for tests
			},
		};

		ceCoreExtension(pi as never);

		const brainstormDialog = definitions.get("brainstorm_dialog");
		const result = await brainstormDialog.execute("tool-call-id", {
			operation: "start",
			repoRoot: `/tmp/pi-ce-bd-runtime-${Date.now()}`,
			artifactPath: "docs/brainstorms/2026-04-24-runtime-requirements.md",
			analysis: "Initial analysis",
			questions: ["What exactly is broken?"],
		});

		expect(result.terminate).not.toBe(true);
		expect(result.details.openQuestions).toEqual(["What exactly is broken?"]);
	});

	test("conversation-state tools do not terminate the agent turn", async () => {
		const definitions = new Map<string, any>();
		const pi = {
			registerTool(definition: { name: string }) {
				definitions.set(definition.name, definition);
			},
			on(_event: string, _handler: any) {
				// no-op for tests
			},
			registerCommand(_name: string, _def: any) {
				// no-op for tests
			},
		};

		ceCoreExtension(pi as never);

		const workflowState = definitions.get("workflow_state");
		const reviewRouter = definitions.get("review_router");
		const sessionCheckpoint = definitions.get("session_checkpoint");
		const sessionHistory = definitions.get("session_history");
		const patternExtractor = definitions.get("pattern_extractor");

		const workflowStateResult = await workflowState.execute("tool-call-id", {
			repoRoot: `/tmp/pi-ce-ws-runtime-${Date.now()}`,
		});
		expect(workflowStateResult.terminate).not.toBe(true);

		const reviewRouterResult = await reviewRouter.execute("tool-call-id", {
			filesChanged: ["src/auth.ts"],
			insertions: 10,
			deletions: 2,
		});
		expect(reviewRouterResult.terminate).not.toBe(true);

		const checkpointRepoRoot = `/tmp/pi-ce-checkpoint-runtime-${Date.now()}`;
		const checkpointResult = await sessionCheckpoint.execute("tool-call-id", {
			operation: "load",
			repoRoot: checkpointRepoRoot,
			planPath: "docs/plans/demo-plan.md",
		});
		expect(checkpointResult.terminate).not.toBe(true);

		const historyRepoRoot = `/tmp/pi-ce-history-runtime-${Date.now()}`;
		const historyResult = await sessionHistory.execute("tool-call-id", {
			operation: "query",
			repoRoot: historyRepoRoot,
		});
		expect(historyResult.terminate).not.toBe(true);

		const patternResult = await patternExtractor.execute("tool-call-id", {
			operation: "extract",
			artifacts: [{ path: "docs/a.md", content: "oauth token refresh oauth" }],
			keywords: ["oauth"],
		});
		expect(patternResult.terminate).not.toBe(true);
	});

	test("context_handoff wrapper passes structured runtime-memory fields through", async () => {
		disableHandoffPolicyForWrapperContract();
		const definitions = new Map<string, any>();
		const pi = {
			registerTool(definition: { name: string }) {
				definitions.set(definition.name, definition);
			},
			on(_event: string, _handler: any) {
				// no-op for tests
			},
			registerCommand(_name: string, _def: any) {
				// no-op for tests
			},
		};

		ceCoreExtension(pi as never);

		const contextHandoff = definitions.get("context_handoff");
		const repoRoot = `/tmp/pi-ce-handoff-wrapper-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".context", "compound-engineering", "stage-reports"), { recursive: true });
		await writeFile(path.join(repoRoot, ".context", "compound-engineering", "stage-reports", "03-work.md"), "bun test: 10 pass, 0 fail");
		await mkdir(path.join(repoRoot, ".context", "compound-engineering", "checkpoints"), { recursive: true });
		await writeFile(path.join(repoRoot, ".context", "compound-engineering", "checkpoints", "c.json"), JSON.stringify({ status: "ok", completedUnits: ["u1"] }));
		await mkdir(path.join(repoRoot, "docs", "plans"), { recursive: true });
		await writeFile(path.join(repoRoot, "docs", "plans", "plan.md"), "# Plan\n\nbody");

		const result = await contextHandoff.execute("tool-call-id", {
			operation: "save",
			repoRoot,
			currentStage: "03-work",
			nextStage: "04-review",
			activeFiles: ["src/a.ts"],
			currentTruth: ["Fact A", "Fact B"],
			invalidatedAssumptions: ["Old assumption"],
			openDecisions: ["Decision X"],
			recentlyAccessedFiles: ["file1.ts"],
			compressionRisk: ["Risk Z"],
		});

		expect(result.details.currentTruth).toEqual(["Fact A", "Fact B"]);
		expect(result.details.invalidatedAssumptions).toEqual(["Old assumption"]);
		expect(result.details.openDecisions).toEqual(["Decision X"]);
		expect(result.details.recentlyAccessedFiles).toEqual(["file1.ts"]);
		expect(result.details.compressionRisk).toEqual(["Risk Z"]);
	});

	test("context_handoff wrapper supports validate operation with probes and checks", async () => {
		disableHandoffPolicyForWrapperContract();
		const definitions = new Map<string, any>();
		const pi = {
			registerTool(definition: { name: string }) {
				definitions.set(definition.name, definition);
			},
			on(_event: string, _handler: any) {
				// no-op for tests
			},
			registerCommand(_name: string, _def: any) {
				// no-op for tests
			},
		};

		ceCoreExtension(pi as never);

		const contextHandoff = definitions.get("context_handoff");
		const repoRoot = `/tmp/pi-ce-handoff-validate-wrapper-${Date.now()}`;
		await mkdir(path.join(repoRoot, "docs", "plans"), { recursive: true });
		await writeFile(path.join(repoRoot, "docs", "plans", "plan.md"), PLAN_FIXTURE);

		// First save a handoff with recall + continuation evidence
		await contextHandoff.execute("tool-call-id", {
			operation: "save",
			repoRoot,
			currentStage: "02-plan",
			nextStage: "03-work",
			currentTruth: ["Fact A"],
			handoffMarkdown:
				"## Current Task\nTask.\n\n## Next Minimal Step\nDo it.\n",
		});

		// Now validate
		const result = await contextHandoff.execute("tool-call-id", {
			operation: "validate",
			repoRoot,
		});

		expect(result.details.operation).toBe("validate");
		expect(result.details.ok).toBe(true);
		expect(result.details.probes).toBeDefined();
		expect(result.details.probes.recall).toBe(true);
		expect(result.details.probes.continuation).toBe(true);
		expect(result.details.checks).toBeDefined();
		expect(result.details.checks.length).toBeGreaterThan(0);
		expect(result.details.recommendedAction).toBe("continue");
	});
});

describe("multi_reviewer tool", () => {
	test("returns empty findings when no reviewers are configured in config.json", async () => {
		const repoRoot = `/tmp/pi-ce-reviewer-none-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				review: {
					model: "anthropic/claude-3-opus",
					thinkingLevel: "high",
					reviewers: [],
				},
			}),
			"utf8",
		);

		const tool = createMultiReviewerTool();
		const result = await tool.execute({
			stepName: "review",
			primaryOutput: "const x = 1",
			repoRoot,
		});

		expect(result.findings).toEqual([]);
		expect(result.compiledSummary).toBe("No reviewers configured.");
	});

	test("compiles list of findings correctly", async () => {
		const repoRoot = `/tmp/pi-ce-reviewer-compile-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				review: {
					model: "anthropic/claude-3-opus",
					thinkingLevel: "high",
					reviewers: [],
				},
			}),
			"utf8",
		);

		const tool = createMultiReviewerTool();
		const result = await tool.execute({
			stepName: "review",
			primaryOutput: "const x = 1",
			repoRoot,
		});
		expect(result.findings).toBeDefined();
	});

	test("automatically loads reviewers from config.json", async () => {
		const repoRoot = `/tmp/pi-ce-reviewer-autoload-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				review: {
					model: "anthropic/claude-3-haiku",
					thinkingLevel: "high",
					reviewers: [
						{ model: "anthropic/claude-3-opus", thinkingLevel: "high" },
						{ model: "anthropic/claude-3-sonnet", thinkingLevel: "medium" },
					],
				},
			}),
			"utf8",
		);

		const tool = createMultiReviewerTool();
		const result = await tool.execute({
			stepName: "review",
			primaryOutput: "const x = 1",
			repoRoot,
		});

		expect(result.compiledSummary).toContain(
			"We ran the review across 2 reviewer model(s).",
		);
	});

	test("does not fallback and returns no reviewers configured when reviewer config is missing", async () => {
		const repoRoot = `/tmp/pi-ce-reviewer-fallback-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				// Empty config, no "review" block
			}),
			"utf8",
		);

		const tool = createMultiReviewerTool();
		const result = await tool.execute({
			stepName: "review",
			primaryOutput: "const x = 1",
			repoRoot,
		});

		expect(result.findings).toEqual([]);
		expect(result.compiledSummary).toBe("No reviewers configured.");
	});

	test("normalizes stepName (whitespace and casing) when loading configuration", async () => {
		const repoRoot = `/tmp/pi-ce-reviewer-normalize-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				learn: {
					model: "opencode-go/deepseek-v4-flash",
					thinkingLevel: "medium",
					reviewers: [
						{ model: "opencode-go/mimo-v2.5", thinkingLevel: "medium" },
					],
				},
			}),
			"utf8",
		);

		const tool = createMultiReviewerTool();
		const result = await tool.execute({
			stepName: "  05-Learn  ",
			primaryOutput: "const x = 1",
			repoRoot,
		});

		expect(result.compiledSummary).toContain(
			"We ran the review across 1 reviewer model(s).",
		);
	});
});

// ── Auto-advance wiring integration tests (Unit 2) ──

describe("auto-advance tool_result wiring", () => {
	beforeEach(() => {
		clearAutoAdvanceCache();
		resetPedstackState();
	});

	function createPiMock() {
		const sendUserMessageCalls: Array<{ message: string; options: any }> = [];
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const appendEntryCalls: Array<{ type: string; data: any }> = [];
		const setModelCalls: Array<{ provider: string; id: string }> = [];
		const setThinkingLevelCalls: string[] = [];
		const registeredNames: string[] = [];
		const registeredCommands = new Map<string, any>();
		const eventHandlers = new Map<string, any[]>();
		let currentThinkingLevel = "medium";

		const pi = {
			registerTool(definition: { name: string }) {
				registeredNames.push(definition.name);
			},
			on(event: string, handler: any) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerCommand(name: string, def: any) {
				registeredCommands.set(name, def);
			},
			sendUserMessage(message: string, options: any) {
				sendUserMessageCalls.push({ message, options });
			},
			appendEntry(type: string, data: any) {
				appendEntryCalls.push({ type, data });
			},
			async setModel(model: { provider: string; id: string }) {
				setModelCalls.push(model);
				return true;
			},
			getThinkingLevel() {
				return currentThinkingLevel;
			},
			setThinkingLevel(level: string) {
				currentThinkingLevel = level;
				setThinkingLevelCalls.push(level);
			},
		};

		function makeEventCtx(overrides: any = {}) {
			let confirmIndex = 0;
			return {
				hasUI: true,
				isIdle: () => true,
				ui: {
					confirm: async (_title: string, _message: string) => {
						const result = overrides.confirmResults?.[confirmIndex] ?? true;
						confirmIndex++;
						return result;
					},
					notify: (message: string, level: string) => {
						notifyCalls.push({ message, level });
					},
				},
				...overrides,
			};
		}

		function makeCommandCtx(repoRoot: string, overrides: any = {}) {
			const navigateCalls: string[] = [];
			const ctx = {
				hasUI: true,
				cwd: repoRoot,
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
							message: {
								role: "user",
								content: [{ type: "text", text: "root" }],
							},
						},
					],
				},
				model: { provider: "openai", id: "gpt-4.1-mini" },
				modelRegistry: {
					find: (provider: string, id: string) => ({ provider, id }),
				},
				ui: {
					notify: (message: string, level: string) => {
						notifyCalls.push({ message, level });
					},
				},
				navigateTree: async (targetId: string) => {
					navigateCalls.push(targetId);
					return { cancelled: false };
				},
				waitForIdle: async () => {},
				...overrides,
			};
			return { ctx, navigateCalls };
		}

		return {
			pi,
			eventHandlers,
			registeredCommands,
			registeredNames,
			sendUserMessageCalls,
			notifyCalls,
			appendEntryCalls,
			setModelCalls,
			setThinkingLevelCalls,
			makeEventCtx,
			makeCommandCtx,
		};
	}

	function makeEvent(overrides: Record<string, any> = {}) {
		return {
			toolName: "context_handoff",
			input: { operation: "save" },
			content: [
				{
					type: "text",
					text: JSON.stringify({
						currentStage: "01-brainstorm",
						nextStage: "02-plan",
					}),
				},
			],
			isError: false,
			...overrides,
		};
	}

	async function settleAutoAdvance(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	test("registers 6 tool_result handlers and an agent_end handler", () => {
		const { pi, eventHandlers } = createPiMock();
		ceCoreExtension(pi as never);

		expect(eventHandlers.get("tool_result")?.length).toBe(6);
		expect(eventHandlers.get("tool_call")?.length).toBe(1);
		expect(eventHandlers.get("agent_end")?.length).toBe(1);
	});

	test("failure triage handler ignores non-bash results", async () => {
		const { pi, eventHandlers, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const triageHandler = eventHandlers.get("tool_result")!.at(-1)!;
		const result = await triageHandler(
			{
				toolName: "read",
				input: { command: "bun test" },
				content: [{ type: "text", text: "output" }],
				isError: true,
				details: {},
			},
			makeEventCtx({ cwd: "/tmp" }),
		);

		expect(result).toBeUndefined();
	});

	test("failure triage handler ignores bash results without an active stage", async () => {
		const { pi, eventHandlers, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);
		clearActiveStage();

		const triageHandler = eventHandlers.get("tool_result")!.at(-1)!;
		const result = await triageHandler(
			{
				toolName: "bash",
				input: { command: "bun test" },
				content: [{ type: "text", text: "FAIL test/foo.test.ts" }],
				isError: true,
				details: {},
			},
			makeEventCtx({ cwd: `/tmp/pi-ce-triage-none-${Date.now()}` }),
		);

		expect(result).toBeUndefined();
	});

	test("failure triage handler annotates a failing bash result and never sets isError", async () => {
		const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ce-triage-"));
		const { pi, eventHandlers, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("03-work");

		try {
			const triageHandler = eventHandlers.get("tool_result")!.at(-1)!;
			const result = await triageHandler(
				{
					toolName: "bash",
					input: { command: "bun test" },
					content: [
						{
							type: "text",
							text: "FAIL test/foo.test.ts\nexpected 1 received 2",
						},
					],
					isError: true,
					details: {},
				},
				makeEventCtx({ cwd: repoRoot }),
			);

			expect(result).toBeDefined();
			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toContain("TRIAGE");
			expect(
				result.content[0].text.startsWith("FAIL test/foo.test.ts"),
			).toBe(true);
			expect(result.details.triage.category).toBe("test_fixture");
			expect(result.details.triage.source).toBe("heuristic");
			expect(result.details.triage.relatedToRecentChange).toBe("unknown");
			expect(typeof result.details.triage.rootCauseClarity).toBe("number");
		} finally {
			clearActiveStage();
		}
	});

	test("session_shutdown clears the in-memory active stage", async () => {
		const { pi, eventHandlers, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("03-work");

		// Index 1 is the injection-screen cleanup; the stage-clear handler is last.
		const shutdown = eventHandlers.get("session_shutdown")!.at(-1)!;
		await shutdown({ type: "session_shutdown" }, makeEventCtx());

		expect(getActiveStage()).toBeNull();
	});

	test("registers stage_gate, solution_search, and the semantic tools", () => {
		const { pi, registeredNames } = createPiMock();
		ceCoreExtension(pi as never);

		expect(registeredNames).toContain("stage_gate");
		expect(registeredNames).toContain("stage_report");
		expect(registeredNames).toContain("solution_search");
		expect(registeredNames).toContain("docs_verification");
		expect(registeredNames).toContain("semantic_read");
		expect(registeredNames).toContain("semantic_scout");
		expect(registeredNames.length).toBe(20);
	});

	test("enforced stage escalation auto-reloads the same stage under SOTA after agent_end", async () => {
		const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ce-sota-reload-"));
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				models: {
					default: { model: "openai/small" },
					sota: { model: "openai/strong" },
				},
				routing: { shadow: false },
			}),
		);
		const {
			pi, eventHandlers, registeredCommands, sendUserMessageCalls,
			appendEntryCalls, setModelCalls, makeEventCtx, makeCommandCtx,
		} = createPiMock();
		ceCoreExtension(pi as never);
		const { ctx, navigateCalls } = makeCommandCtx(repoRoot);
		try {
			await registeredCommands.get("ped-start").handler("Build a CLI", ctx);
			sendUserMessageCalls.length = 0;
			appendEntryCalls.length = 0;
			setModelCalls.length = 0;
			const gateDir = path.join(repoRoot, ".context", "compound-engineering", "stage-gates");
			await mkdir(gateDir, { recursive: true });
			await writeFile(path.join(gateDir, "01-brainstorm.json"), JSON.stringify({
				stage: "01-brainstorm",
				attempts: [{
					stage: "01-brainstorm", verdict: "escalate",
					review: { action: "escalate", reviewerCount: 0, reason: "gate" },
					updatedAt: new Date().toISOString(),
				}],
			}));
			const gateHandler = eventHandlers.get("tool_result")![4];
			const gateEvent = {
				toolName: "stage_gate",
				isError: false,
				details: { stage: "01-brainstorm", action: "escalate", enforcing: true },
			};
			await gateHandler(gateEvent, makeEventCtx({
				cwd: repoRoot, model: { provider: "openai", id: "small" },
			}));
			expect(sendUserMessageCalls).toHaveLength(0);
			await eventHandlers.get("agent_end")![0](
				{ type: "agent_end" }, makeEventCtx({ cwd: repoRoot }),
			);
			await settleAutoAdvance();
			expect(sendUserMessageCalls).toHaveLength(1);
			expect(sendUserMessageCalls[0].message).toContain("SOTA escalation");
			expect(appendEntryCalls.at(-1)?.data.stage).toBe("01-brainstorm");
			expect(appendEntryCalls.at(-1)?.type).toBe("ped-stage-reload");
			expect(setModelCalls).toContainEqual({ provider: "openai", id: "strong" });
			expect(navigateCalls).toHaveLength(2);
			await gateHandler(gateEvent, makeEventCtx({
				cwd: repoRoot, model: { provider: "openai", id: "small" },
			}));
			await eventHandlers.get("agent_end")![0](
				{ type: "agent_end" }, makeEventCtx({ cwd: repoRoot }),
			);
			await settleAutoAdvance();
			expect(sendUserMessageCalls).toHaveLength(1);
		} finally {
			resetPedstackState();
		}
	});

	test("restricted stages cannot queue a SOTA auto-reload even for legacy escalation results", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);
		const gateHandler = eventHandlers.get("tool_result")![4];
		for (const stage of ["03-work", "04-review", "05-learn", "06-docsync"]) {
			setActiveStage(stage);
			await gateHandler({
				toolName: "stage_gate",
				isError: false,
				details: { stage, action: "escalate", enforcing: true },
			}, makeEventCtx({ cwd: "/tmp", model: { provider: "openai", id: "small" } }));
			await eventHandlers.get("agent_end")![0](
				{ type: "agent_end" }, makeEventCtx({ cwd: "/tmp" }),
			);
			expect(sendUserMessageCalls).toHaveLength(0);
		}
	});

	test("shadow-mode gate escalation does not auto-reload", async () => {
		const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ce-shadow-reload-"));
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				models: { default: { model: "openai/small" }, sota: { model: "openai/strong" } },
				routing: { shadow: true },
			}),
		);
		const { pi, eventHandlers, registeredCommands, sendUserMessageCalls, makeEventCtx, makeCommandCtx } = createPiMock();
		ceCoreExtension(pi as never);
		const { ctx } = makeCommandCtx(repoRoot);
		try {
			await registeredCommands.get("ped-start").handler("Build a CLI", ctx);
			sendUserMessageCalls.length = 0;
			await eventHandlers.get("tool_result")![4]({
				toolName: "stage_gate",
				isError: false,
				details: { stage: "01-brainstorm", action: "escalate", enforcing: true },
			}, makeEventCtx({
				cwd: repoRoot, model: { provider: "openai", id: "small" },
			}));
			await eventHandlers.get("agent_end")![0](
				{ type: "agent_end" }, makeEventCtx({ cwd: repoRoot }),
			);
			await settleAutoAdvance();
			expect(sendUserMessageCalls).toHaveLength(0);
		} finally {
			resetPedstackState();
		}
	});

	test("does not queue for non-context_handoff tool", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeEventCtx } =
			createPiMock();
		ceCoreExtension(pi as never);

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const result = await autoAdvanceHandler(
			makeEvent({ toolName: "bash" }),
			makeEventCtx(),
		);

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("queues auto-advance on save and runs the real stage transition on agent_end", async () => {
		const repoRoot = `/tmp/pi-ce-auto-advance-${Date.now()}`;
		await mkdir(path.join(repoRoot, ".pi", "pi-pedstack"), { recursive: true });
		await writeFile(
			path.join(repoRoot, ".pi", "pi-pedstack", "config.json"),
			JSON.stringify({
				plan: {
					model: "anthropic/claude-3-7-sonnet",
					thinkingLevel: "high",
				},
			}),
			"utf8",
		);

		const {
			pi,
			eventHandlers,
			registeredCommands,
			sendUserMessageCalls,
			appendEntryCalls,
			setModelCalls,
			setThinkingLevelCalls,
			makeEventCtx,
			makeCommandCtx,
		} = createPiMock();
		ceCoreExtension(pi as never);

		const { ctx, navigateCalls } = makeCommandCtx(repoRoot);
		await registeredCommands
			.get("ped-start")
			.handler("brainstorm the bug", ctx);
		sendUserMessageCalls.length = 0;
		appendEntryCalls.length = 0;
		setModelCalls.length = 0;
		setThinkingLevelCalls.length = 0;

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const agentEndHandler = eventHandlers.get("agent_end")![0];

		await autoAdvanceHandler(makeEvent(), makeEventCtx());
		expect(sendUserMessageCalls.length).toBe(0);

		await agentEndHandler({ type: "agent_end" }, makeEventCtx());
		await settleAutoAdvance();

		expect(sendUserMessageCalls.length).toBe(1);
		expect(sendUserMessageCalls[0].message).toBe("Stage: 02-plan");
		expect(sendUserMessageCalls[0].options).toBeUndefined();
		expect(navigateCalls.length).toBe(2);
		expect(appendEntryCalls.at(-1)).toEqual({
			type: "ped-stage-start",
			data: { returnTo: "leaf-1", stage: "02-plan" },
		});
		expect(setModelCalls).toEqual([
			{ provider: "anthropic", id: "claude-3-7-sonnet" },
		]);
		expect(setThinkingLevelCalls).toEqual(["high"]);
	});

	test("gated transition does not run when confirm returns false", async () => {
		const repoRoot = `/tmp/pi-ce-auto-advance-gated-${Date.now()}`;
		const {
			pi,
			eventHandlers,
			registeredCommands,
			sendUserMessageCalls,
			makeEventCtx,
			makeCommandCtx,
		} = createPiMock();
		ceCoreExtension(pi as never);

		const { ctx } = makeCommandCtx(repoRoot);
		await registeredCommands
			.get("ped-start")
			.handler("brainstorm the bug", ctx);
		sendUserMessageCalls.length = 0;

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const agentEndHandler = eventHandlers.get("agent_end")![0];
		const gatedEvent = makeEvent({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						currentStage: "02-plan",
						nextStage: "03-work",
					}),
				},
			],
		});

		await autoAdvanceHandler(gatedEvent, makeEventCtx());
		await agentEndHandler(
			{ type: "agent_end" },
			makeEventCtx({ hasUI: true, confirmResults: [false] }),
		);
		await settleAutoAdvance();

		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("waits for idle before starting queued auto-advance", async () => {
		const repoRoot = `/tmp/pi-ce-auto-advance-idle-${Date.now()}`;
		const {
			pi,
			eventHandlers,
			registeredCommands,
			sendUserMessageCalls,
			makeEventCtx,
			makeCommandCtx,
		} = createPiMock();
		ceCoreExtension(pi as never);

		const { ctx } = makeCommandCtx(repoRoot);
		await registeredCommands
			.get("ped-start")
			.handler("brainstorm the bug", ctx);
		sendUserMessageCalls.length = 0;

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const agentEndHandler = eventHandlers.get("agent_end")![0];
		let idle = false;
		setTimeout(() => {
			idle = true;
		}, 0);

		await autoAdvanceHandler(makeEvent(), makeEventCtx());
		await agentEndHandler(
			{ type: "agent_end" },
			makeEventCtx({ isIdle: () => idle }),
		);
		expect(sendUserMessageCalls.length).toBe(0);

		await settleAutoAdvance();
		expect(sendUserMessageCalls.length).toBe(1);
	});

	test("warns when auto-advance has no remembered command context", async () => {
		const { pi, eventHandlers, notifyCalls, makeEventCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const agentEndHandler = eventHandlers.get("agent_end")![0];

		await autoAdvanceHandler(makeEvent(), makeEventCtx());
		await agentEndHandler({ type: "agent_end" }, makeEventCtx({ hasUI: true }));
		await settleAutoAdvance();

		expect(notifyCalls.at(-1)).toEqual({
			message:
				"Auto-advance is queued but no live workflow command context is available. Run /ped-next manually.",
			level: "warning",
		});
	});

	test("handles event with null content gracefully", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeEventCtx } =
			createPiMock();
		ceCoreExtension(pi as never);

		const autoAdvanceHandler = eventHandlers.get("tool_result")![4];
		const result = await autoAdvanceHandler(
			makeEvent({ content: null }),
			makeEventCtx(),
		);

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});
});
