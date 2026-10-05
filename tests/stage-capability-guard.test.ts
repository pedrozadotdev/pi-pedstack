import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import ceCoreExtension from "../extensions/ce-core/index";
import {
	clearActiveStage,
	setActiveStage,
} from "../extensions/ce-core/utils/active-stage";

// ── Fake pi harness ────────────────────────────────────────────────

function createPiMock() {
	const registeredNames: string[] = [];
	const eventHandlers = new Map<string, any[]>();
	const notifyCalls: Array<{ message: string; level: string }> = [];

	const pi = {
		registerTool(definition: { name: string }) {
			registeredNames.push(definition.name);
		},
		on(event: string, handler: any) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerCommand(_name: string, _def: any) {},
		appendEntry(_type: string, _data?: any) {},
		sendUserMessage(_content: any, _opts?: any) {},
		setModel: async () => true,
		setThinkingLevel: () => {},
		getThinkingLevel: () => "medium",
	};

	function makeCtx(cwd: string, overrides: Record<string, any> = {}) {
		return {
			hasUI: true,
			cwd,
			ui: {
				notify: (message: string, level: string) => {
					notifyCalls.push({ message, level });
				},
			},
			...overrides,
		};
	}

	return { pi, registeredNames, eventHandlers, notifyCalls, makeCtx };
}

function writeEvent(target: string) {
	return {
		type: "tool_call",
		toolName: "write",
		input: { path: target, content: "x" },
	};
}

function editEvent(target: string) {
	return {
		type: "tool_call",
		toolName: "edit",
		input: { path: target, edits: [] },
	};
}

const tempRepos: string[] = [];
async function makeRepo(): Promise<string> {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-stage-guard-"));
	tempRepos.push(repo);
	return repo;
}

async function seedWorkflowState(repo: string, stage: string): Promise<void> {
	const dir = path.join(repo, ".context", "compound-engineering");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "context-state.json"),
		JSON.stringify({ currentStage: stage }),
		"utf8",
	);
	await writeFile(
		path.join(dir, "active-stage.json"),
		JSON.stringify({ activeStage: stage }),
		"utf8",
	);
}

beforeEach(() => {
	clearActiveStage();
	delete process.env.PEDSTACK_DISABLE_GUARD;
});

afterEach(async () => {
	clearActiveStage();
	delete process.env.PEDSTACK_DISABLE_GUARD;
	await Promise.all(
		tempRepos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
	);
});

// ── Unit 4: registration + decisions ───────────────────────────────

describe("stage capability guard", () => {
	test("registers exactly one tool_call handler and keeps tool/handler counts", () => {
		const { pi, registeredNames, eventHandlers } = createPiMock();
		ceCoreExtension(pi as never);

		expect(eventHandlers.get("tool_call")?.length).toBe(1);
		expect(eventHandlers.get("tool_result")?.length).toBe(3);
		expect(registeredNames).toContain("stage_gate");
		expect(registeredNames).toContain("solution_search");
		expect(registeredNames.length).toBe(16);
	});

	test("02-plan blocks a source write with a reason naming stage and path", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");

		const handler = eventHandlers.get("tool_call")![0];
		const result = await handler(
			writeEvent("extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);

		expect(result).toMatchObject({ block: true });
		expect(result.reason).toContain("02-plan");
		expect(result.reason).toContain("extensions/ce-core/index.ts");
	});

	test("02-plan allows a plan edit", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");

		const handler = eventHandlers.get("tool_call")![0];
		const result = await handler(editEvent("docs/plans/x.md"), makeCtx("/repo"));

		expect(result).toBeUndefined();
	});

	test("03-work allows source and blocks plan", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("03-work");

		const handler = eventHandlers.get("tool_call")![0];
		expect(
			await handler(writeEvent("extensions/ce-core/index.ts"), makeCtx("/repo")),
		).toBeUndefined();
		expect(
			(await handler(writeEvent("docs/plans/x.md"), makeCtx("/repo")))?.block,
		).toBe(true);
	});

	test("04-5-debug allows tests/config and blocks deps", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("04-5-debug");

		const handler = eventHandlers.get("tool_call")![0];
		expect(
			await handler(writeEvent("tests/x.test.ts"), makeCtx("/repo")),
		).toBeUndefined();
		expect(
			await handler(writeEvent("package.json"), makeCtx("/repo")),
		).toBeUndefined();
		expect((await handler(writeEvent("bun.lock"), makeCtx("/repo")))?.block).toBe(
			true,
		);
	});

	test("workflow-state is blocked in every stage and when idle", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		const handler = eventHandlers.get("tool_call")![0];
		const target = ".context/compound-engineering/active-stage.json";

		for (const stage of [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
			"06-docsync",
			null,
		]) {
			setActiveStage(stage);
			const result = await handler(writeEvent(target), makeCtx("/repo"));
			expect(result?.block).toBe(true);
		}
	});

	test("non-write/edit tools and missing paths fail open", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		expect(
			await handler(
				{ type: "tool_call", toolName: "bash", input: { command: "rm -rf /" } },
				makeCtx("/repo"),
			),
		).toBeUndefined();
		expect(
			await handler(
				{ type: "tool_call", toolName: "write", input: {} },
				makeCtx("/repo"),
			),
		).toBeUndefined();
		expect(
			await handler(
				{ type: "tool_call", toolName: "write", input: { path: 42 } },
				makeCtx("/repo"),
			),
		).toBeUndefined();
	});

	test("unknown path class is allowed in a restrictive stage", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		expect(
			await handler(writeEvent("assets/logo.png"), makeCtx("/repo")),
		).toBeUndefined();
	});

	test("falls back to the persisted stage when memory is empty", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		const repo = await makeRepo();
		await seedWorkflowState(repo, "02-plan");
		clearActiveStage();

		const handler = eventHandlers.get("tool_call")![0];
		const result = await handler(
			writeEvent("extensions/ce-core/index.ts"),
			makeCtx(repo),
		);

		expect(result?.block).toBe(true);
	});

	test("PEDSTACK_DISABLE_GUARD=1 allows every write", async () => {
		process.env.PEDSTACK_DISABLE_GUARD = "1";
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");

		const handler = eventHandlers.get("tool_call")![0];
		expect(
			await handler(writeEvent("extensions/ce-core/index.ts"), makeCtx("/repo")),
		).toBeUndefined();
		expect(
			await handler(
				writeEvent(".context/compound-engineering/context-state.json"),
				makeCtx("/repo"),
			),
		).toBeUndefined();
	});
});

// ── Unit 5: adversarial paths + failure isolation ──────────────────

describe("stage capability guard hardening", () => {
	test("classifies traversal and mixed-separator paths as source and blocks them", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		const traversal = await handler(
			writeEvent("docs/plans/../../extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);
		expect(traversal?.block).toBe(true);

		const mixed = await handler(
			writeEvent("extensions\\ce-core\\index.ts"),
			makeCtx("/repo"),
		);
		expect(mixed?.block).toBe(true);

		const absolute = await handler(
			writeEvent("/repo/extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);
		expect(absolute?.block).toBe(true);
	});

	test("outside-repo paths stay unknown and are allowed", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		const result = await handler(
			writeEvent("../../etc/passwd"),
			makeCtx("/repo"),
		);
		expect(result).toBeUndefined();
	});

	test("guard error fails open and notifies exactly once", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		const throwingEvent = {
			type: "tool_call",
			toolName: "write",
			get input(): { path?: unknown } {
				throw new Error("boom");
			},
		};

		expect(await handler(throwingEvent, makeCtx("/repo"))).toBeUndefined();
		expect(await handler(throwingEvent, makeCtx("/repo"))).toBeUndefined();
		expect(notifyCalls.length).toBe(1);
		expect(notifyCalls[0].message).toContain("failed open");
	});

	test("persisted-read failure fails open and notifies once", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage(null);

		const ctx = makeCtx("/repo");
		Object.defineProperty(ctx, "cwd", {
			get() {
				throw new Error("cwd boom");
			},
			configurable: true,
		});

		const handler = eventHandlers.get("tool_call")![0];
		expect(
			await handler(writeEvent("extensions/ce-core/index.ts"), ctx),
		).toBeUndefined();
		expect(
			await handler(writeEvent("extensions/ce-core/index.ts"), ctx),
		).toBeUndefined();
		expect(notifyCalls.length).toBe(1);
	});

	test("notification dedup holds across mixed blocked and allowed calls", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		const throwingEvent = {
			type: "tool_call",
			toolName: "write",
			get input(): { path?: unknown } {
				throw new Error("first boom");
			},
		};
		expect(await handler(throwingEvent, makeCtx("/repo"))).toBeUndefined();

		await handler(writeEvent("extensions/ce-core/index.ts"), makeCtx("/repo"));
		await handler(writeEvent("docs/plans/x.md"), makeCtx("/repo"));
		expect(await handler(throwingEvent, makeCtx("/repo"))).toBeUndefined();

		expect(notifyCalls.length).toBe(1);
	});

	test("idle session with no workflow is a silent allow", async () => {
		const { pi, eventHandlers, notifyCalls, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage(null);

		const handler = eventHandlers.get("tool_call")![0];
		const result = await handler(
			writeEvent("extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);

		expect(result).toBeUndefined();
		expect(notifyCalls.length).toBe(0);
	});
});
