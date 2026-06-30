import { describe, expect, test, beforeEach, mock } from "bun:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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
import ceCoreExtension from "../extensions/ce-core/index";
import { createMultiReviewerTool } from "../extensions/ce-core/tools/multi-reviewer";

describe("ce-core extension runtime registration", () => {
	test("registers 14 workflow control tools (no subagent tools)", () => {
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
			"workflow_state",
			"review_router",
			"session_checkpoint",
			"task_splitter",
			"brainstorm_dialog",
			"plan_diff",
			"session_history",
			"pattern_extractor",
			"context_handoff",
			"checklist_add",
			"checklist_show",
			"checklist_del",
			"multi_reviewer",
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
					model: "anthropic/claude-3-opus",
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
	});

	// Helper to create a pi mock with tracked sendUserMessage and handlers
	function createPiMock() {
		const sendUserMessageCalls: Array<{ message: string; options: any }> = [];
		const notifyCalls: Array<{ message: string; level: string }> = [];
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
				// no-op
			},
			sendUserMessage(message: string, options: any) {
				sendUserMessageCalls.push({ message, options });
			},
		};

		function makeCtx(overrides: any = {}) {
			let confirmIndex = 0;
			const { ctxOverrides, confirmResults: _cr, ...rest } = overrides;
			return {
				hasUI: true,
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
				...rest,
				...ctxOverrides,
			};
		}

		return {
			pi,
			eventHandlers,
			registeredNames,
			sendUserMessageCalls,
			notifyCalls,
			makeCtx,
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

	test("registers 3 tool_result handlers (bash filter, read filter, auto-advance)", () => {
		const { pi, eventHandlers } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result");
		expect(handlers).toBeDefined();
		expect(handlers!.length).toBe(3);
	});

	test("tool count remains 14 (no new tools added)", () => {
		const { pi, registeredNames } = createPiMock();
		ceCoreExtension(pi as never);

		expect(registeredNames).toEqual([
			"artifact_helper",
			"workflow_state",
			"review_router",
			"session_checkpoint",
			"task_splitter",
			"brainstorm_dialog",
			"plan_diff",
			"session_history",
			"pattern_extractor",
			"context_handoff",
			"checklist_add",
			"checklist_show",
			"checklist_del",
			"multi_reviewer",
		]);
	});

	test("does not dispatch for non-context_handoff tool", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		// The auto-advance handler is the third one registered
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({ toolName: "bash" });
		const result = await autoAdvanceHandler(event, makeCtx());

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("does not dispatch for context_handoff load operation", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({ input: { operation: "load" } });
		const result = await autoAdvanceHandler(event, makeCtx());

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("dispatches /ped-next for 01→02 (auto transition) with deliverAs followUp", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent();
		const result = await autoAdvanceHandler(event, makeCtx({ hasUI: true }));

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(1);
		expect(sendUserMessageCalls[0].message).toBe("/ped-next");
		expect(sendUserMessageCalls[0].options.deliverAs).toBe("followUp");
	});

	test("dispatches confirm for 02→03 (gated) then sends on confirm true", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({
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

		await autoAdvanceHandler(
			event,
			makeCtx({
				hasUI: true,
				confirmResults: [true],
			}),
		);

		expect(sendUserMessageCalls.length).toBe(1);
		expect(sendUserMessageCalls[0].message).toBe("/ped-next");
	});

	test("does not send when gated confirm resolves false", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({
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

		await autoAdvanceHandler(
			event,
			makeCtx({
				hasUI: true,
				confirmResults: [false],
			}),
		);

		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("skips confirm and sends in print mode (hasUI=false) for gated transition", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({
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

		await autoAdvanceHandler(event, makeCtx({ hasUI: false }));

		expect(sendUserMessageCalls.length).toBe(1);
		expect(sendUserMessageCalls[0].message).toBe("/ped-next");
	});

	test("gated confirm skipped on second save (cache hit)", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({
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

		// First save: confirm returns true
		await autoAdvanceHandler(
			event,
			makeCtx({
				hasUI: true,
				confirmResults: [true],
			}),
		);
		expect(sendUserMessageCalls.length).toBe(1);

		// Second save: should use cache, no confirm dialog
		await autoAdvanceHandler(
			event,
			makeCtx({
				hasUI: true,
				// No confirm results needed — cache should skip dialog
			}),
		);

		// Cache persists across calls within the same session (module-level Set)
		// — second save skips the confirm dialog because markAuthorized was called.
		expect(sendUserMessageCalls.length).toBe(2);
	});

	test("catches sendUserMessage errors and calls notify", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();

		// Make sendUserMessage throw
		(pi as any).sendUserMessage = () => {
			throw new Error("Network error");
		};

		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent();

		// Should not throw
		await expect(
			autoAdvanceHandler(event, makeCtx({ hasUI: true })),
		).resolves.toBeUndefined();

		expect(notifyCalls.length).toBeGreaterThan(0);
		expect(notifyCalls[0].level).toBe("error");
	});

	test("catches sendUserMessage errors silently in print mode", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();

		// Make sendUserMessage throw
		(pi as any).sendUserMessage = () => {
			throw new Error("Network error");
		};

		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent();

		await expect(
			autoAdvanceHandler(event, makeCtx({ hasUI: false })),
		).resolves.toBeUndefined();

		// No notify since hasUI is false
		expect(notifyCalls.length).toBe(0);
	});

	test("handles event with null content gracefully", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({ content: null });
		const result = await autoAdvanceHandler(event, makeCtx());

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});

	test("handles event with empty content array gracefully", async () => {
		const { pi, eventHandlers, sendUserMessageCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);

		const handlers = eventHandlers.get("tool_result")!;
		const autoAdvanceHandler = handlers[2];

		const event = makeEvent({ content: [] });
		const result = await autoAdvanceHandler(event, makeCtx());

		expect(result).toBeUndefined();
		expect(sendUserMessageCalls.length).toBe(0);
	});
});
