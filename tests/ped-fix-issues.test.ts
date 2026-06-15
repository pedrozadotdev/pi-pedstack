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
	setPendingSkillPath,
	getAndClearPendingSkillPath,
	setPendingFixIssues,
	getAndClearPendingFixIssues,
	resetPedstackState,
} from "../extensions/ce-core/commands/pedstack";
import {
	buildSystemPromptAppend,
	extractStageKey,
} from "../extensions/ce-core/commands/prompt-inject";
import {
	parseIssueNumbers,
	cmdPedFixIssues,
} from "../extensions/ce-core/commands/pedstack";

describe("pending fix-issues state", () => {
	afterEach(() => {
		resetPedstackState();
	});

	test("stores and clears issue numbers", () => {
		setPendingFixIssues(["01", "02"]);
		expect(getAndClearPendingFixIssues()).toEqual(["01", "02"]);
		expect(getAndClearPendingFixIssues()).toEqual([]);
	});

	test("returns empty array when nothing stored", () => {
		expect(getAndClearPendingFixIssues()).toEqual([]);
	});

	test("set empty array stores nothing", () => {
		setPendingFixIssues([]);
		expect(getAndClearPendingFixIssues()).toEqual([]);
	});

	test("both channels are independent; overwrite per channel", () => {
		setPendingSkillPath("/skills/01-brainstorm/SKILL.md");
		setPendingFixIssues(["42"]);

		expect(getAndClearPendingSkillPath()).toBe(
			"/skills/01-brainstorm/SKILL.md",
		);
		expect(getAndClearPendingFixIssues()).toEqual(["42"]);

		// Both cleared after one read
		expect(getAndClearPendingSkillPath()).toBeNull();
		expect(getAndClearPendingFixIssues()).toEqual([]);

		// Overwrite fix-issues only
		setPendingFixIssues(["99"]);
		setPendingFixIssues(["88"]);
		expect(getAndClearPendingFixIssues()).toEqual(["88"]);
	});

	test("resetPedstackState clears both channels", () => {
		setPendingSkillPath("/skills/02-plan/SKILL.md");
		setPendingFixIssues(["01", "02", "03"]);
		resetPedstackState();
		expect(getAndClearPendingSkillPath()).toBeNull();
		expect(getAndClearPendingFixIssues()).toEqual([]);
	});

	test("mutation safety: setPendingFixIssues stores a defensive copy", () => {
		const original = ["01", "02"];
		setPendingFixIssues(original);
		original.push("03"); // mutate original
		expect(getAndClearPendingFixIssues()).toEqual(["01", "02"]);
	});
});

// ── Unit 2: buildSystemPromptAppend and extractStageKey ──

import {
	buildSystemPromptAppend,
	extractStageKey,
} from "../extensions/ce-core/commands/prompt-inject";

describe("extractStageKey", () => {
	test("extracts stage key from POSIX path", () => {
		expect(extractStageKey("/skills/01-brainstorm/SKILL.md")).toBe(
			"01-brainstorm",
		);
	});

	test("extracts stage key from Windows path", () => {
		expect(extractStageKey("C:\\skills\\01-brainstorm\\SKILL.md")).toBe(
			"01-brainstorm",
		);
	});

	test("extracts stage key from mixed separator path", () => {
		expect(extractStageKey("/skills/01-brainstorm\\SKILL.md")).toBe(
			"01-brainstorm",
		);
	});

	test("returns null for empty string", () => {
		expect(extractStageKey("")).toBeNull();
	});

	test("returns null when no SKILL.md suffix", () => {
		expect(extractStageKey("no-skill-suffix")).toBeNull();
	});

	test("returns null for .bak extension", () => {
		expect(extractStageKey(".../SKILL.md.bak")).toBeNull();
	});

	test("returns last segment for double SKILL.md path", () => {
		expect(extractStageKey("prefix/SKILL.md/SKILL.md")).toBe("SKILL.md");
	});
});

describe("buildSystemPromptAppend", () => {
	test("returns empty string when both inputs empty/null", () => {
		expect(buildSystemPromptAppend(null, [])).toBe("");
	});

	test("returns stage-focus guard + skill-reading for each pipeline stage", () => {
		for (const stage of [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
			"06-docsync",
		]) {
			const result = buildSystemPromptAppend(`/skills/${stage}/SKILL.md`, []);
			expect(result).toContain("Pipeline Discipline: Stage Focus");
			expect(result).toContain(`entering stage **${stage}**`);
			expect(result).toContain("Pipeline Stage: Skill Instructions");
			expect(result).toContain(`/skills/${stage}/SKILL.md`);
			expect(result).not.toContain("Pipeline Discipline: No Implementation");
		}
	});

	test("each stage has distinct mandate and forbidden text", () => {
		const results = [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
			"06-docsync",
		].map((stage) => buildSystemPromptAppend(`/skills/${stage}/SKILL.md`, []));
		// Every result should be unique (distinct mandate per stage)
		for (let i = 0; i < results.length; i++) {
			for (let j = i + 1; j < results.length; j++) {
				expect(results[i]).not.toBe(results[j]);
			}
		}
	});

	test("returns generic guard + skill-reading for unrecognized stage (e.g., 00-next)", () => {
		const result = buildSystemPromptAppend("/skills/00-next/SKILL.md", []);
		expect(result).toContain("Pipeline Discipline: No Implementation");
		expect(result).toContain("Pipeline Stage: Skill Instructions");
		expect(result).toContain("/skills/00-next/SKILL.md");
	});

	test("fix-issues only when fixIssues set and stage is 01-brainstorm", () => {
		const result = buildSystemPromptAppend("/skills/01-brainstorm/SKILL.md", [
			"42",
		]);
		expect(result).toContain("Fetch GitHub Issues for Context");
		expect(result).toContain("Pipeline Discipline: Stage Focus");
		expect(result).toContain("Pipeline Stage: Skill Instructions");
		expect(result).toContain("#42");
	});

	test("fix-issues omitted when stage is not 01-brainstorm", () => {
		const result = buildSystemPromptAppend("/skills/02-plan/SKILL.md", ["42"]);
		expect(result).toContain("Pipeline Discipline: Stage Focus");
		expect(result).toContain("Pipeline Stage: Skill Instructions");
		expect(result).not.toContain("Fetch GitHub Issues");
	});

	test("fix-issues omitted when stage is 03-work even with fixIssues", () => {
		const result = buildSystemPromptAppend("/skills/03-work/SKILL.md", ["42"]);
		expect(result).toContain("Pipeline Discipline: Stage Focus");
		expect(result).toContain("Pipeline Stage: Skill Instructions");
		expect(result).not.toContain("Fetch GitHub Issues");
	});

	test("stage-focus guard includes handoff instruction for non-terminal stages", () => {
		for (const stage of [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
		]) {
			const result = buildSystemPromptAppend(`/skills/${stage}/SKILL.md`, []);
			expect(result).toContain("save a context handoff");
			expect(result).toContain("context_handoff tool");
			expect(result).not.toContain("terminal stage");
		}
	});

	test("terminal stage 06-docsync uses terminal handoff language", () => {
		const result = buildSystemPromptAppend("/skills/06-docsync/SKILL.md", []);
		expect(result).toContain("save a final context handoff");
		expect(result).toContain("terminal stage");
	});

	test("01-brainstorm mandate forbids plans, architecture, and code", () => {
		const result = buildSystemPromptAppend(
			"/skills/01-brainstorm/SKILL.md",
			[],
		);
		expect(result).toContain("Your mandate:");
		expect(result).toContain("Explore ideas");
		expect(result).toContain("Forbidden:");
		expect(result).toContain("Do NOT write plans");
		expect(result).toContain("do NOT write or edit any source code");
	});

	test("03-work mandate requires implementation and testing", () => {
		const result = buildSystemPromptAppend("/skills/03-work/SKILL.md", []);
		expect(result).toContain("Your mandate:");
		expect(result).toContain("Implement the code");
		expect(result).toContain("Write tests");
		expect(result).toContain("Forbidden:");
		expect(result).toContain("Do NOT change scope");
		expect(result).toContain("do NOT move to review without passing tests");
	});

	test("fix-issues text matches verbatim template with issue list substituted", () => {
		const result = buildSystemPromptAppend("/skills/01-brainstorm/SKILL.md", [
			"01",
			"02",
			"03",
		]);
		expect(result).toContain("Fetch GitHub Issues for Context");
		expect(result).toContain(
			"Run `gh issue view <number>` for each issue: #01, #02, #03",
		);
		expect(result).toContain("Execute the Brainstorm Skill");
	});

	test("skill-reading text matches pinned verbatim string with path substituted", () => {
		const result = buildSystemPromptAppend(
			"/skills/01-brainstorm/SKILL.md",
			[],
		);
		expect(result).toContain("Pipeline Stage: Skill Instructions");
		expect(result).toContain(
			"You are entering a new pipeline stage. You MUST immediately read the following",
		);
		expect(result).toContain("/skills/01-brainstorm/SKILL.md");
		expect(result).toContain(
			"After reading the skill, follow its instructions precisely.",
		);
	});
});

// ── Unit 3: parseIssueNumbers and cmdPedFixIssues ──

import {
	parseIssueNumbers,
	cmdPedFixIssues,
} from "../extensions/ce-core/commands/pedstack";

describe("parseIssueNumbers", () => {
	test("parses space-separated numbers", () => {
		expect(parseIssueNumbers("01 02 03")).toEqual(["01", "02", "03"]);
	});

	test("strips non-digit characters from segments", () => {
		expect(parseIssueNumbers("#01  abc  #03")).toEqual(["01", "03"]);
	});

	test("filters segments that become empty after stripping", () => {
		expect(parseIssueNumbers("abc def")).toEqual([]);
		expect(parseIssueNumbers("01  abc  ")).toEqual(["01"]);
	});

	test("deduplicates numbers while preserving order", () => {
		expect(parseIssueNumbers("01 01 02")).toEqual(["01", "02"]);
	});

	test("caps at 10 unique numbers", () => {
		const result = parseIssueNumbers("01 02 03 04 05 06 07 08 09 10 11");
		expect(result).toEqual([
			"01",
			"02",
			"03",
			"04",
			"05",
			"06",
			"07",
			"08",
			"09",
			"10",
		]);
		expect(result.length).toBe(10);
	});

	test("returns empty array for empty string", () => {
		expect(parseIssueNumbers("")).toEqual([]);
	});
});

describe("cmdPedFixIssues", () => {
	test("empty args notifies warning and does not send message", async () => {
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
		} as any;

		const ctx = {
			hasUI: true,
			cwd: "/tmp/test",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getBranch: () => [
					{ type: "message", id: "msg-1", parentId: "root-1" } as any,
				],
			},
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level: level ?? "info" });
				},
			},
			navigateTree: async () => ({ cancelled: false }),
			waitForIdle: async () => {},
		} as any;

		const cmd = cmdPedFixIssues(pi);
		await cmd.handler("", ctx);

		expect(notifications.length).toBeGreaterThan(0);
		expect(notifications[0].message).toContain("No valid issue numbers");
		expect(sentMessage).toBeNull();
	});

	test("sends message with formatted issue list", async () => {
		let sentMessage: any = null;
		const order: string[] = [];

		const pi = {
			appendEntry: () => {},
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
					{ type: "message", id: "msg-1", parentId: "root-1" } as any,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {} },
			navigateTree: async () => {
				order.push("navigate");
				return { cancelled: false };
			},
			waitForIdle: async () => {},
			get selectedApiProvider() {
				return undefined;
			},
		} as any;

		resetPedstackState();

		const cmd = cmdPedFixIssues(pi);
		await cmd.handler("01 02", ctx);

		expect(sentMessage).toContain("Fetch GitHub issues");
		expect(sentMessage).toContain("#01, #02");
		expect(order).toContain("navigate");
	});

	test("navigates to fresh context before setting state", async () => {
		const order: string[] = [];

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
					{ type: "message", id: "msg-1", parentId: "root-1" } as any,
				],
			},
			model: { provider: "anthropic", id: "sonnet" },
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {} },
			navigateTree: async () => {
				order.push("navigate");
				return { cancelled: false };
			},
			waitForIdle: async () => {},
		} as any;

		resetPedstackState();

		const cmd = cmdPedFixIssues(pi);
		await cmd.handler("42", ctx);

		expect(order).toEqual(["navigate"]);
	});
});

// ── Unit 7: Registration update ──

describe("ce-core extension registers commands", () => {
	test("registers ped-start, ped-next, and ped-fix-issues commands", () => {
		const registeredCommands: string[] = [];
		const pi = {
			registerTool(_def: any) {},
			on(_event: string, _handler: any) {},
			registerCommand(name: string, _def: any) {
				registeredCommands.push(name);
			},
		};

		ceCoreExtension(pi as never);

		expect(registeredCommands).toContain("ped-start");
		expect(registeredCommands).toContain("ped-next");
		expect(registeredCommands).toContain("ped-fix-issues");
	});
});

// ── Unit 4: before_agent_start handler integration ──

describe("before_agent_start handler", () => {
	const setupHandler = () => {
		const eventHandlers = new Map<string, (...args: any[]) => any>();
		const pi = {
			registerTool(_def: any) {},
			on(event: string, handler: (...args: any[]) => any) {
				eventHandlers.set(event, handler);
			},
			registerCommand(_name: string, _def: any) {},
		};

		ceCoreExtension(pi as never);

		return eventHandlers.get("before_agent_start");
	};

	test("returns undefined when no pending state (both channels empty)", async () => {
		const handler = setupHandler()!;

		resetPedstackState();

		const result = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base prompt",
		});

		expect(result).toBeUndefined();
	});

	test("returns systemPrompt with correct block ordering", async () => {
		const handler = setupHandler()!;
		setPendingSkillPath("/skills/01-brainstorm/SKILL.md");
		setPendingFixIssues(["42"]);

		const result = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result).toBeDefined();
		expect(result.systemPrompt).toContain("base");
		expect(result.systemPrompt).toContain("Pipeline Discipline: Stage Focus");
		expect(result.systemPrompt).toContain("Pipeline Stage: Skill Instructions");
		expect(result.systemPrompt).toContain("Fetch GitHub Issues for Context");

		// Verify order: guard → skill → fix-issues
		const guardIdx = result.systemPrompt.indexOf(
			"Pipeline Discipline: Stage Focus",
		);
		const skillIdx = result.systemPrompt.indexOf(
			"Pipeline Stage: Skill Instructions",
		);
		const fixIdx = result.systemPrompt.indexOf("Fetch GitHub Issues");
		expect(guardIdx).toBeLessThan(skillIdx);
		expect(skillIdx).toBeLessThan(fixIdx);
	});

	test("stage-focus guard present for 03-work stage transition", async () => {
		const handler = setupHandler()!;
		setPendingSkillPath("/skills/03-work/SKILL.md");

		const result = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result.systemPrompt).toContain("Pipeline Discipline: Stage Focus");
		expect(result.systemPrompt).toContain("Implement the code");
		expect(result.systemPrompt).toContain("Pipeline Stage: Skill Instructions");
	});

	test("generic guard present for unrecognized stage keys (00-next)", async () => {
		const handler = setupHandler()!;
		setPendingSkillPath("/skills/00-next/SKILL.md");

		const result = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result.systemPrompt).toContain(
			"Pipeline Discipline: No Implementation",
		);
		expect(result.systemPrompt).toContain("Pipeline Stage: Skill Instructions");
	});

	test("fix-issues omitted when stage is not 01-brainstorm", async () => {
		const handler = setupHandler()!;
		setPendingSkillPath("/skills/02-plan/SKILL.md");
		setPendingFixIssues(["42"]);

		const result = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result.systemPrompt).toContain("Pipeline Discipline");
		expect(result.systemPrompt).toContain("Pipeline Stage: Skill Instructions");
		expect(result.systemPrompt).not.toContain("Fetch GitHub Issues");
	});

	test("both channels cleared in one invocation", async () => {
		const handler = setupHandler()!;
		setPendingSkillPath("/skills/01-brainstorm/SKILL.md");
		setPendingFixIssues(["42"]);

		await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		// After invocation, both channels should be cleared
		expect(getAndClearPendingSkillPath()).toBeNull();
		expect(getAndClearPendingFixIssues()).toEqual([]);
	});

	test("partial set produces partial block (returns undefined)", async () => {
		const handler = setupHandler()!;

		// Set only fix-issues (no skill path)
		setPendingFixIssues(["99"]);

		// First call: buildSystemPromptAppend returns "" when skillPath is null,
		// so the handler returns undefined (no-op, preserves chaining)
		const result1 = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result1).toBeUndefined();

		// Second call should also return undefined since channel was cleared
		const result2 = await handler({
			systemPromptOptions: { skills: [] },
			systemPrompt: "base",
		});

		expect(result2).toBeUndefined();
	});
});

describe("public exports", () => {
	test("only exports the extension default and public utility functions", async () => {
		const mod = await import("../extensions/ce-core/index");
		const exportNames = Object.keys(mod).filter((k) => k !== "default");

		const expectedExports = [
			"createArtifactHelperTool",
			"createWorkflowStateTool",
			"createReviewRouterTool",
			"createSessionCheckpointTool",
			"createTaskSplitterTool",
			"createBrainstormDialogTool",
			"createPlanDiffTool",
			"createSessionHistoryTool",
			"createPatternExtractorTool",
			"createContextHandoffTool",
			"createMultiReviewerTool",
			"getBrainstormArtifactPath",
			"getPlanArtifactPath",
			"getSolutionArtifactPath",
			"getRunArtifactPath",
			"normalizeSlug",
			"filterBashOutput",
			"filterReadOutput",
			"COMPACTION_FOCUS_INSTRUCTIONS",
		];

		expect(exportNames.sort()).toEqual(expectedExports.sort());
	});
});
