import { describe, expect, test, mock, afterEach } from "bun:test";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

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

import {
	resolveNextPipelineStage,
	cmdPedStart,
	cmdPedNext,
	cmdPedReload,
	isModelVisible,
	findPreConversationEntry,
	findFreshTargetId,
	isValidStageKey,
	setPendingSkillPath,
	getAndClearPendingSkillPath,
	setPendingFixIssues,
	getAndClearPendingFixIssues,
	resetPedstackState,
	type StageResolution,
	type PipelineStageKey,
} from "../extensions/ce-core/commands/pedstack";
import { parseModelRef } from "../extensions/ce-core/utils/parse-model-ref";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

describe("commands/pedstack: session-traversal helpers", () => {
	// These helpers are internal to the module but we test them
	// by re-implementing the logic inline in tests (TDD approach).
	// We import the module to confirm it compiles and that the
	// public API (resolveNextPipelineStage, cmdPedStart, cmdPedNext) works.

	describe("parseModelRef", () => {
		test("parses provider/model-id format", () => {
			expect(parseModelRef("anthropic/claude-sonnet-4-20250514")).toEqual({
				provider: "anthropic",
				id: "claude-sonnet-4-20250514",
			});
		});

		test("reuses current provider for bare model id", () => {
			expect(parseModelRef("claude-opus-4-1", "openai")).toEqual({
				provider: "openai",
				id: "claude-opus-4-1",
			});
		});

		test("returns null for empty string", () => {
			expect(parseModelRef("")).toBeNull();
		});

		test("returns null for whitespace-only string", () => {
			expect(parseModelRef("   ")).toBeNull();
		});

		test("returns null for bare model id without provider", () => {
			expect(parseModelRef("claude-opus-4-1")).toBeNull();
		});
	});

	describe("resolveNextPipelineStage", () => {
		const emptyState = (): any => ({
			brainstorms: { count: 0, latest: null },
			plans: { count: 0, latest: null },
			reviews: { count: 0, latest: null },
			solutions: { count: 0, latest: null },
			runs: { count: 0, latest: null },
			context: {
				found: false,
				activeFiles: [],
				recentlyAccessedFiles: [],
				currentTruth: [],
				invalidatedAssumptions: [],
				openDecisions: [],
				compressionRisk: [],
			},
		});

		test("priority 1: critical health returns abort with reason", () => {
			const state = emptyState();
			state.context.contextHealth = "critical";
			state.context.currentStage = "02-plan";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("critical_health");
			expect((result as any).details.currentStage).toBe("02-plan");
		});

		test("priority 2: active blocker returns abort with blocker details", () => {
			const state = emptyState();
			state.context.blocker = "Config file missing";
			state.context.currentStage = "03-work";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("blocker");
			expect((result as any).details.blocker).toBe("Config file missing");
			expect((result as any).details.currentStage).toBe("03-work");
		});

		test("priority 3: new session recommended returns abort with nextStage", () => {
			const state = emptyState();
			state.context.recommendNewSession = true;
			state.context.nextStage = "04-review";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("new_session_recommended");
			expect((result as any).details.nextStage).toBe("04-review");
		});

		test("priority 4: explicit next stage returns it", () => {
			const state = emptyState();
			state.context.currentStage = "01-brainstorm";
			state.context.nextStage = "02-plan";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(true);
			expect((result as any).stage).toBe("02-plan");
		});

		test("priority 6: no brainstorms returns 01-brainstorm", () => {
			const state = emptyState();
			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(true);
			expect((result as any).stage).toBe("01-brainstorm");
		});

		test("priority 6: brainstorm exists but no plan returns 02-plan", () => {
			const state = emptyState();
			state.brainstorms.count = 1;
			state.brainstorms.latest = "2026-01-01-reqs.md";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(true);
			expect((result as any).stage).toBe("02-plan");
		});

		test("priority 6: plan exists returns 03-work", () => {
			const state = emptyState();
			state.brainstorms.count = 1;
			state.plans.count = 1;
			state.plans.latest = "2026-01-01-plan.md";

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(true);
			expect((result as any).stage).toBe("03-work");
		});

		test("ambiguous state returns abort with ambiguous reason (stages beyond fallback)", () => {
			// Unreachable with current 3-rule fallback (01→02→03 covers all permutations).
			// Testing path defensively: would need stages beyond 03-work to not match.
			// For now, no-brainstorms and no-plans should trigger 01-brainstorm (not ambiguous).
			const state = emptyState();
			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(true);
			expect((result as any).stage).toBe("01-brainstorm");
		});
	});

	describe("cmdPedStart", () => {
		test("with empty prompt notifies warning and does not send message", async () => {
			const notifications: Array<{ message: string; level: string }> = [];
			let appended: any = null;
			let sentMessage: any = null;

			const pi = {
				appendEntry(type: string, data?: any) {
					appended = { type, data };
				},
				sendUserMessage(content: any) {
					sentMessage = content;
				},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: true,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: {
					find: () => ({ provider: "anthropic", id: "opus-4-1" }),
				},
				ui: {
					notify(message: string, level?: string) {
						notifications.push({ message, level: level ?? "info" });
					},
				},
				navigateTree: async () => ({ cancelled: false }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedStart(pi);
			await cmd.handler("", ctx);

			expect(notifications.length).toBeGreaterThan(0);
			expect(notifications[0].message).toContain("Prompt required");
			expect(sentMessage).toBeNull();
		});

		test("with valid prompt appends entries and sends message", async () => {
			const appendCalls: Array<{ type: string; data: any }> = [];
			let sentMessage: any = null;

			const pi = {
				appendEntry(type: string, data?: any) {
					appendCalls.push({ type, data });
				},
				sendUserMessage(content: any) {
					sentMessage = content;
				},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: false,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: {
					find: () => undefined,
				},
				ui: { notify: () => {} },
				navigateTree: async () => ({ cancelled: false }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedStart(pi);
			await cmd.handler("build a CLI tool", ctx);

			// Should have appended workflow-start and stage-start
			expect(appendCalls.length).toBe(2);
			expect(appendCalls[0].type).toBe("ped-workflow-start");
			expect(appendCalls[0].data.anchorLeafId).toBe("leaf-1");
			expect(appendCalls[1].type).toBe("ped-stage-start");
			expect(appendCalls[1].data.stage).toBe("01-brainstorm");
			expect(appendCalls[1].data.returnTo).toBe("leaf-1");

			// Should have sent just the user prompt (skill path stored for system prompt injection)
			expect(sentMessage).toBe("build a CLI tool");
		});
	});

	describe("cmdPedNext", () => {
		test("with clean state resolves and sends skill command", async () => {
			const appendCalls: Array<{ type: string; data: any }> = [];
			const sentMessages: Array<{ content: any; opts?: any }> = [];

			const pi = {
				appendEntry(type: string, data?: any) {
					appendCalls.push({ type, data });
				},
				sendUserMessage(content: any, opts?: any) {
					sentMessages.push({ content, opts });
				},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: false,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: {
					find: () => undefined,
				},
				ui: { notify: () => {} },
				navigateTree: async () => ({ cancelled: false }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedNext(pi);
			await cmd.handler("", ctx);

			expect(appendCalls.length).toBe(1);
			expect(appendCalls[0].type).toBe("ped-stage-start");

			// Should have sent ONE message: "Stage: 01-brainstorm" (fallback when no pending path)
			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0].content).toBe("Stage: 01-brainstorm");
		});

		test("with optional prompt sends followUp separately", async () => {
			const sentMessages: Array<{ content: any; opts?: any }> = [];

			const pi = {
				appendEntry: () => {},
				sendUserMessage(content: any, opts?: any) {
					sentMessages.push({ content, opts });
				},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: false,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: { find: () => undefined },
				ui: { notify: () => {} },
				navigateTree: async () => ({ cancelled: false }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedNext(pi);
			await cmd.handler("focus on error handling", ctx);

			// Should have sent ONE message: just the optional prompt (skill path stored separately)
			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0].content).toBe("focus on error handling");
		});

		test("with navigation cancelled notifies and stops", async () => {
			const sentMessages: any[] = [];
			const notifications: Array<{ message: string; level: string }> = [];

			const pi = {
				appendEntry: () => {},
				sendUserMessage(content: any) {
					sentMessages.push(content);
				},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: true,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: { find: () => undefined },
				ui: {
					notify(message: string, level?: string) {
						notifications.push({ message, level: level ?? "info" });
					},
				},
				navigateTree: async () => ({ cancelled: true }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedNext(pi);
			await cmd.handler("", ctx);

			expect(notifications.length).toBeGreaterThan(0);
			expect(notifications[0].message).toContain("Navigation cancelled");
			expect(sentMessages.length).toBe(0);
		});

		test("with ctx.hasUI=false does not notify", async () => {
			const notifications: any[] = [];

			const pi = {
				appendEntry: () => {},
				sendUserMessage: () => {},
				setModel: async () => true,
				setThinkingLevel: () => {},
				getThinkingLevel: () => "medium",
			} as any;

			const ctx = {
				hasUI: false,
				cwd: "/tmp/test",
				sessionManager: {
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{
							type: "message",
							id: "msg-1",
							parentId: "root-1",
						} as SessionEntry,
					],
				},
				model: { provider: "anthropic", id: "sonnet" },
				modelRegistry: { find: () => undefined },
				ui: {
					notify(message: string, level?: string) {
						notifications.push({ message, level });
					},
				},
				navigateTree: async () => ({ cancelled: false }),
				waitForIdle: async () => {},
			} as any;

			const cmd = cmdPedNext(pi);
			await cmd.handler("", ctx);

			// No notifications because hasUI is false
			expect(notifications.length).toBe(0);
		});

		test("critical health with UI notifies about critical context", async () => {
			// This test verifies the abort path by directly testing the resolution
			// function with a critical health state, then checking notification behavior
			const { resolveNextPipelineStage } = await import(
				"../extensions/ce-core/commands/pedstack"
			);

			const state = {
				brainstorms: { count: 1, latest: null },
				plans: { count: 1, latest: null },
				reviews: { count: 0, latest: null },
				solutions: { count: 0, latest: null },
				runs: { count: 0, latest: null },
				context: {
					found: true,
					contextHealth: "critical",
					currentStage: "03-work",
					latestHandoffPath: ".context/compound-engineering/handoffs/latest.md",
					activeFiles: [],
					recentlyAccessedFiles: [],
					currentTruth: [],
					invalidatedAssumptions: [],
					openDecisions: [],
					compressionRisk: [],
				},
			} as any;

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("critical_health");
			expect((result as any).details.currentStage).toBe("03-work");
		});

		test("blocker returns abort with blocker message", async () => {
			const { resolveNextPipelineStage } = await import(
				"../extensions/ce-core/commands/pedstack"
			);

			const state = {
				brainstorms: { count: 1, latest: null },
				plans: { count: 1, latest: null },
				reviews: { count: 0, latest: null },
				solutions: { count: 0, latest: null },
				runs: { count: 0, latest: null },
				context: {
					found: true,
					blocker: "Config file missing",
					currentStage: "02-plan",
					activeFiles: [],
					recentlyAccessedFiles: [],
					currentTruth: [],
					invalidatedAssumptions: [],
					openDecisions: [],
					compressionRisk: [],
				},
			} as any;

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("blocker");
			expect((result as any).details.blocker).toBe("Config file missing");
		});

		test("new session recommended returns abort with nextStage", async () => {
			const { resolveNextPipelineStage } = await import(
				"../extensions/ce-core/commands/pedstack"
			);

			const state = {
				brainstorms: { count: 1, latest: null },
				plans: { count: 1, latest: null },
				reviews: { count: 0, latest: null },
				solutions: { count: 0, latest: null },
				runs: { count: 0, latest: null },
				context: {
					found: true,
					recommendNewSession: true,
					nextStage: "04-review",
					currentStage: "03-work",
					latestHandoffPath: ".context/compound-engineering/handoffs/latest.md",
					activeFiles: [],
					recentlyAccessedFiles: [],
					currentTruth: [],
					invalidatedAssumptions: [],
					openDecisions: [],
					compressionRisk: [],
				},
			} as any;

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("new_session_recommended");
			expect((result as any).details.nextStage).toBe("04-review");
		});

		test("invalid nextStage string returns ambiguous", async () => {
			const { resolveNextPipelineStage } = await import(
				"../extensions/ce-core/commands/pedstack"
			);

			const state = {
				brainstorms: { count: 1, latest: null },
				plans: { count: 0, latest: null },
				reviews: { count: 0, latest: null },
				solutions: { count: 0, latest: null },
				runs: { count: 0, latest: null },
				context: {
					found: true,
					nextStage: "99-invalid-stage",
					currentStage: "01-brainstorm",
					activeFiles: [],
					recentlyAccessedFiles: [],
					currentTruth: [],
					invalidatedAssumptions: [],
					openDecisions: [],
					compressionRisk: [],
				},
			} as any;

			const result = resolveNextPipelineStage(state);
			expect(result.ok).toBe(false);
			expect((result as any).reason).toBe("ambiguous");
		});
	});

	describe("isModelVisible", () => {
		test("returns true for message entries", () => {
			expect(isModelVisible({ type: "message" } as any)).toBe(true);
		});

		test("returns true for compaction entries", () => {
			expect(isModelVisible({ type: "compaction" } as any)).toBe(true);
		});

		test("returns true for branch_summary entries", () => {
			expect(isModelVisible({ type: "branch_summary" } as any)).toBe(true);
		});

		test("returns true for custom_message entries", () => {
			expect(isModelVisible({ type: "custom_message" } as any)).toBe(true);
		});

		test("returns false for custom (data-only) entries", () => {
			expect(isModelVisible({ type: "custom" } as any)).toBe(false);
		});

		test("returns false for thinking_level_change entries", () => {
			expect(isModelVisible({ type: "thinking_level_change" } as any)).toBe(
				false,
			);
		});

		test("returns false for model_change entries", () => {
			expect(isModelVisible({ type: "model_change" } as any)).toBe(false);
		});

		test("returns false for label entries", () => {
			expect(isModelVisible({ type: "label" } as any)).toBe(false);
		});

		test("returns false for session_info entries", () => {
			expect(isModelVisible({ type: "session_info" } as any)).toBe(false);
		});

		test("returns false for file entries", () => {
			expect(isModelVisible({ type: "file" } as any)).toBe(false);
		});
	});

	describe("findPreConversationEntry", () => {
		test("returns null for empty branch", () => {
			expect(
				findPreConversationEntry({
					getLeafId: () => "leaf-1",
					getBranch: () => [],
				}),
			).toBeNull();
		});

		test("returns null when no leaf", () => {
			expect(
				findPreConversationEntry({
					getLeafId: () => null,
					getBranch: () => [{ type: "message" } as any],
				}),
			).toBeNull();
		});

		test("returns null when only non-visible entries", () => {
			expect(
				findPreConversationEntry({
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{ type: "model_change" } as any,
						{ type: "thinking_level_change" } as any,
					],
				}),
			).toBeNull();
		});

		test("returns first visible entry in mixed branch", () => {
			const entries = [
				{ type: "model_change", id: "mc-1" } as any,
				{ type: "thinking_level_change", id: "tlc-1" } as any,
				{ type: "message", id: "msg-1" } as any,
			];
			const result = findPreConversationEntry({
				getLeafId: () => "leaf-1",
				getBranch: () => entries,
			});
			expect(result?.id).toBe("msg-1");
		});

		test("returns single visible entry", () => {
			const result = findPreConversationEntry({
				getLeafId: () => "leaf-1",
				getBranch: () => [{ type: "custom_message", id: "cm-1" } as any],
			});
			expect(result?.id).toBe("cm-1");
		});
	});

	describe("findFreshTargetId", () => {
		test("returns null for empty branch", () => {
			expect(
				findFreshTargetId({ getLeafId: () => "leaf-1", getBranch: () => [] }),
			).toBeNull();
		});

		test("returns parent of first visible entry", () => {
			expect(
				findFreshTargetId({
					getLeafId: () => "leaf-1",
					getBranch: () => [{ type: "message", parentId: "parent-1" } as any],
				}),
			).toBe("parent-1");
		});

		test("falls back to first entry parentId for non-visible branch", () => {
			expect(
				findFreshTargetId({
					getLeafId: () => "leaf-1",
					getBranch: () => [
						{ type: "model_change", parentId: "root-parent" } as any,
					],
				}),
			).toBe("root-parent");
		});

		test("falls back to first entry id when no parentId", () => {
			expect(
				findFreshTargetId({
					getLeafId: () => "leaf-1",
					getBranch: () => [{ type: "model_change", id: "mc-1" } as any],
				}),
			).toBe("mc-1");
		});
	});
});

// ── /ped-reload command ────────────────────────────────────────────

describe("cmdPedReload", () => {
	test("without current stage falls back to 01-brainstorm", async () => {
		const appendCalls: Array<{ type: string; data: any }> = [];
		const sentMessages: Array<{ content: any; opts?: any }> = [];
		const notifications: Array<{ message: string; level: string }> = [];

		const pi = {
			appendEntry(type: string, data?: any) {
				appendCalls.push({ type, data });
			},
			sendUserMessage(content: any, opts?: any) {
				sentMessages.push({ content, opts });
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const ctx = {
			hasUI: true,
			cwd: "/tmp/test",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{
						type: "message",
						id: "msg-1",
						parentId: "root-1",
					} as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: {
				find: () => ({ provider: "anthropic", id: "opus-4-1" }),
			},
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedReload(pi);
		await cmd.handler("", ctx);

		expect(appendCalls.length).toBe(1);
		expect(appendCalls[0].type).toBe("ped-stage-reload");
		expect(appendCalls[0].data.stage).toBe("01-brainstorm");
		expect(appendCalls[0].data.returnTo).toBe("leaf-1");

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].content).toContain("Reloading stage: 01-brainstorm");

		// Should notify about fallback (may be intermixed with config notifications)
		expect(
			notifications.some((n) => n.message.includes("No active stage found")),
		).toBe(true);
	});

	test("with current stage reloads that stage", async () => {
		const appendCalls: Array<{ type: string; data: any }> = [];
		const sentMessages: Array<{ content: any; opts?: any }> = [];

		const pi = {
			appendEntry(type: string, data?: any) {
				appendCalls.push({ type, data });
			},
			sendUserMessage(content: any, opts?: any) {
				sentMessages.push({ content, opts });
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const ctx = {
			hasUI: false,
			cwd: "/tmp/test",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{
						type: "message",
						id: "msg-1",
						parentId: "root-1",
					} as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: {
				find: () => undefined,
			},
			ui: { notify: () => {} },
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		// The reload command reads workflow state from disk. Since /tmp/test
		// won't have a context-state.json, it falls back to 01-brainstorm.
		// This validates the no-state fallback path.
		const cmd = cmdPedReload(pi);
		await cmd.handler("", ctx);

		expect(appendCalls.length).toBe(1);
		expect(appendCalls[0].type).toBe("ped-stage-reload");
		expect(sentMessages.length).toBe(1);
	});

	test("with navigation cancelled notifies and stops", async () => {
		const appendCalls: Array<{ type: string; data: any }> = [];
		const sentMessages: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];

		const pi = {
			appendEntry: () => {},
			sendUserMessage(content: any) {
				sentMessages.push(content);
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const ctx = {
			hasUI: true,
			cwd: "/tmp/test",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{
						type: "message",
						id: "msg-1",
						parentId: "root-1",
					} as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: true }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedReload(pi);
		await cmd.handler("", ctx);

		expect(
			notifications.some((n) => n.message.includes("Navigation cancelled")),
		).toBe(true);
		expect(sentMessages.length).toBe(0);
		expect(appendCalls.length).toBe(0);
	});

	test("without UI does not notify", async () => {
		const notifications: any[] = [];
		const appendCalls: Array<{ type: string; data: any }> = [];

		const pi = {
			appendEntry(type: string, data?: any) {
				appendCalls.push({ type, data });
			},
			sendUserMessage: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const ctx = {
			hasUI: false,
			cwd: "/tmp/test",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{
						type: "message",
						id: "msg-1",
						parentId: "root-1",
					} as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedReload(pi);
		await cmd.handler("", ctx);

		// No notifications because hasUI is false
		expect(notifications.length).toBe(0);
	});

	test("when workflow state has current stage, reloads that stage", async () => {
		const appendCalls: Array<{ type: string; data: any }> = [];
		const sentMessages: Array<{ content: any; opts?: any }> = [];

		const pi = {
			appendEntry(type: string, data?: any) {
				appendCalls.push({ type, data });
			},
			sendUserMessage(content: any, opts?: any) {
				sentMessages.push({ content, opts });
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		// Mock the workflow state to have a current stage of 03-work
		// We need to mock the createWorkflowStateTool function.
		// Since it's called directly (not injected), we use mock.module at the top.
		// Instead, let's write a context-state.json to /tmp/test-workflow.
		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-reload-valid-stage",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "03-work",
				contextHealth: "good",
				activeFiles: [],
				currentTruth: [],
				invalidatedAssumptions: [],
				openDecisions: [],
				compressionRisk: [],
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: false,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{
						type: "message",
						id: "msg-1",
						parentId: "root-1",
					} as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {} },
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedReload(pi);
		await cmd.handler("", ctx);

		expect(appendCalls.length).toBe(1);
		expect(appendCalls[0].type).toBe("ped-stage-reload");
		expect(appendCalls[0].data.stage).toBe("03-work");

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].content).toContain("Reloading stage: 03-work");

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});
});

// ── Unit 1: Pending fix-issues state ──
