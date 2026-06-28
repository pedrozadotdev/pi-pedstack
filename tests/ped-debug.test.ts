import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cmdPedDebug } from "../extensions/ce-core/commands/pedstack";

// ── /ped-debug command ────────────────────────────────────────────

describe("cmdPedDebug", () => {
	test("at 04-review handoff appends entries and sends skill message", async () => {
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-at-learn",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: false,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {} },
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(appendCalls.length).toBe(1);
		expect(appendCalls[0].type).toBe("ped-stage-start");
		expect(appendCalls[0].data.stage).toBe("04-5-debug");

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].content).toBe("fix the redirect bug");

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("no workflow state blocks with notification", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const sentMessages: any[] = [];

		const pi = {
			appendEntry: () => {},
			sendUserMessage: (content: any) => {
				sentMessages.push(content);
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const ctx = {
			hasUI: true,
			cwd: "/tmp/test-no-state",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(notifications.length).toBeGreaterThan(0);
		expect(notifications[0].message).toContain("No active workflow");
		expect(sentMessages.length).toBe(0);
	});

	test("empty/whitespace prompt blocks with notification", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const sentMessages: any[] = [];
		const appendCalls: any[] = [];

		const pi = {
			appendEntry(type: string, data?: any) {
				appendCalls.push({ type, data });
			},
			sendUserMessage: (content: any) => {
				sentMessages.push(content);
			},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-empty-prompt",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("   ", ctx);

		expect(
			notifications.some((n) => n.message.includes("A prompt is required")),
		).toBe(true);
		expect(sentMessages.length).toBe(0);
		expect(appendCalls.length).toBe(0);

		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("workflow before 04-review blocks with notification", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-before-review",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "03-work",
				nextStage: "04-review",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(
			notifications.some((n) =>
				n.message.includes("/ped-debug is only available after 04-review"),
			),
		).toBe(true);
		expect(sentMessages.length).toBe(0);

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("workflow at 05-learn blocks with notification", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-at-learn-2",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(
			notifications.some((n) =>
				n.message.includes("/ped-debug is only available after 04-review"),
			),
		).toBe(true);
		expect(sentMessages.length).toBe(0);

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("workflow at 06-docsync blocks with notification", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-at-docsync",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "06-docsync",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(
			notifications.some((n) =>
				n.message.includes("/ped-debug is only available after 04-review"),
			),
		).toBe(true);
		expect(sentMessages.length).toBe(0);

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("navigation cancelled stops and notifies", async () => {
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-nav-cancelled",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
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

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(
			notifications.some((n) => n.message.includes("Navigation cancelled")),
		).toBe(true);
		expect(sentMessages.length).toBe(0);

		// Cleanup
		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("with hasUI=false does not notify", async () => {
		const notifications: any[] = [];

		const pi = {
			appendEntry: () => {},
			sendUserMessage: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-no-ui",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: false,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
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

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(notifications.length).toBe(0);

		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("prompt passed through in sent message", async () => {
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-prompt",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: false,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {} },
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the login redirect bug", ctx);

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].content).toBe("fix the login redirect bug");

		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("current stage 04-review with nextStage 05-learn is allowed", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
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

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-at-review",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		await mkdir(ceDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		// Only allowed state: 04-review with nextStage 05-learn — no block notification
		expect(
			notifications.some((n) =>
				n.message.includes("/ped-debug is only available after 04-review"),
			),
		).toBe(false);
		expect(sentMessages.length).toBe(1);

		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});

	test("switchStageConfig failure caught and notifies", async () => {
		// The switchStageConfig failure path is tested via modelRegistry.find error
		// We simulate this by making setModel throw
		const notifications: Array<{ message: string; level: string }> = [];
		const sentMessages: any[] = [];

		const pi = {
			appendEntry: () => {},
			sendUserMessage(content: any) {
				sentMessages.push(content);
			},
			setModel: async () => {
				throw new Error("Model switch failed");
			},
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
		} as any;

		const testRepo = path.join(
			import.meta.dirname ?? __dirname,
			"..",
			".tmp-test-debug-config-fail",
		);
		const ceDir = path.join(testRepo, ".context", "compound-engineering");
		const piConfigDir = path.join(testRepo, ".pi", "pi-pedstack");
		await mkdir(ceDir, { recursive: true });
		await mkdir(piConfigDir, { recursive: true });
		await writeFile(
			path.join(ceDir, "context-state.json"),
			JSON.stringify({
				currentStage: "04-review",
				nextStage: "05-learn",
				contextHealth: "good",
				updatedAt: new Date().toISOString(),
			}),
		);
		await writeFile(
			path.join(piConfigDir, "config.json"),
			JSON.stringify({
				debug: { model: "anthropic/opus-4-1" },
			}),
		);

		const ctx = {
			hasUI: true,
			cwd: testRepo,
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as SessionEntry,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			// Set a config that triggers model switching
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

		const cmd = cmdPedDebug(pi);
		await cmd.handler("fix the redirect bug", ctx);

		expect(
			notifications.some((n) => n.message.includes("Config switch failed")),
		).toBe(true);
		expect(notifications.some((n) => n.level === "error")).toBe(true);
		expect(sentMessages.length).toBe(0);

		await rm(testRepo, { recursive: true, force: true }).catch(() => {});
	});
});
