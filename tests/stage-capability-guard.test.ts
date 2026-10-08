import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import ceCoreExtension, {
	__setStageGuardJevFactory,
} from "../extensions/ce-core/index";
import { setStartupFeaturesForTests } from "../extensions/ce-core/utils/startup-features";
import { testFeatures } from "./helpers/feature-config";
import {
	clearActiveStage,
	setActiveStage,
} from "../extensions/ce-core/utils/active-stage";
import { GUARD_LOG_FILE } from "../extensions/ce-core/utils/guard-log";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";

// ── Fake pi harness ────────────────────────────────────────────────

function createPiMock() {
	const registeredNames: string[] = [];
	const registeredTools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const eventHandlers = new Map<string, any[]>();
	const notifyCalls: Array<{ message: string; level: string }> = [];

	const pi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) {
			registeredNames.push(definition.name);
			registeredTools.set(definition.name, definition);
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

	return { pi, registeredNames, registeredTools, eventHandlers, notifyCalls, makeCtx };
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
	setStartupFeaturesForTests(testFeatures());
});

afterEach(async () => {
	clearActiveStage();
	setStartupFeaturesForTests(null);
	__setStageGuardJevFactory(null);
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
		expect(eventHandlers.get("tool_result")?.length).toBe(6);
		expect(registeredNames).toContain("stage_gate");
		expect(registeredNames).toContain("stage_report");
		expect(registeredNames).toContain("solution_search");
		expect(registeredNames).toContain("docs_verification");
		expect(registeredNames).toContain("semantic_read");
		expect(registeredNames).toContain("semantic_scout");
		expect(registeredNames.length).toBe(20);
	});

	test("stage_report receives ExtensionContext in the fifth tool argument", async () => {
		const repo = await makeRepo();
		const { pi, registeredTools, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("06-docsync");

		const tool = registeredTools.get("stage_report");
		expect(tool).toBeDefined();
		const report = "# Docsync\\nREADME updated, AGENTS unchanged.\\n## Exit criteria\\nMet.";
		const result = await tool!.execute(
			"tool-call-id",
			{ stage: "06-docsync", markdown: report },
			undefined,
			undefined,
			makeCtx(repo),
		);
		expect(result.details.path).toBe(
			".context/compound-engineering/stage-reports/06-docsync.md",
		);
		expect(await readFile(path.join(repo, result.details.path), "utf8")).toBe(report);
		await expect(
			tool!.execute("another-call", { stage: "03-work", markdown: "wrong" }, undefined, undefined, makeCtx(repo)),
		).rejects.toThrow("not active");
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

	test("features.stageGuard.disabled allows every write", async () => {
		setStartupFeaturesForTests(
			testFeatures({ stageGuard: { disabled: true } }),
		);
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

	test("conflicting-basename .context paths are blocked in 03-work and 06-docsync (C1)", async () => {
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		const handler = eventHandlers.get("tool_call")![0];
		const fixtures = [
			".context/compound-engineering/package.json",
			".context/compound-engineering/bun.lock",
			".context/compound-engineering/notes.test.ts",
			".context/compound-engineering/README.md",
			".context",
		];

		for (const stage of ["03-work", "06-docsync"]) {
			setActiveStage(stage);
			for (const fixture of fixtures) {
				const result = await handler(writeEvent(fixture), makeCtx("/repo"));
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain("workflow-state");
			}
		}
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

// ── Unit 5: bash dispatch via the Jev semantic guard ──────────────

const EFFECT_LABELS = [
	"read_only",
	"mutates_workspace",
	"deletes_or_destructive",
	"installs_dependencies",
	"runs_tests_or_builds",
	"package_runner",
	"pipe_to_shell",
	"container_or_remote",
	"ambiguous",
] as const;

type FakeEffect = (typeof EFFECT_LABELS)[number];

function fakeResponse(
	effect: FakeEffect,
	intent: boolean,
	effectConfidence = 0.9,
	intentConfidence = 0.9,
): string {
	const probabilities = Object.fromEntries(
		EFFECT_LABELS.map((label) => [label, label === effect ? 1 : 0]),
	);
	return JSON.stringify({
		model: "fake",
		answers: {
			effect: { type: "choice", choice: effect, probabilities, confidence: effectConfidence },
			intent: { type: "noul", noul: intent ? 1 : 0, confidence: intentConfidence },
		},
	});
}

function fakeJev(options: {
	effect?: FakeEffect;
	intent?: boolean;
	error?: boolean;
	effectConfidence?: number;
}) {
	const {
		effect = "read_only",
		intent = false,
		error = false,
		effectConfidence = 0.9,
	} = options;
	return createFakeJevRuntime({
		handler: () =>
			error
				? new Error("jev unavailable")
				: {
						exitCode: 0,
						stdout: fakeResponse(effect, intent, effectConfidence),
						stderr: "",
					},
	});
}

function bashEvent(command: string) {
	return { type: "tool_call", toolName: "bash", input: { command } };
}

describe("Unit 5 — bash dispatch via the Jev semantic guard", () => {
	async function setup(options: {
		mode?: string;
		failClosed?: boolean;
		effect?: FakeEffect;
		intent?: boolean;
		error?: boolean;
		stage?: string | null;
	} = {}) {
		const mode =
			options.mode === "off" ||
			options.mode === "shadow" ||
			options.mode === "enforce"
				? options.mode
				: "shadow";
		setStartupFeaturesForTests(
			testFeatures({
				stageGuard: {
					mode,
					failClosed: options.failClosed ?? false,
				},
			}),
		);
		const fake = fakeJev(options);
		__setStageGuardJevFactory(() => fake);
		const { pi, eventHandlers, notifyCalls, makeCtx, registeredNames } =
			createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage(options.stage === undefined ? "02-plan" : options.stage);
		return {
			handler: eventHandlers.get("tool_call")![0],
			fake,
			notifyCalls,
			makeCtx,
			registeredNames,
		};
	}

	test("shadow: deterministic bash never calls Jev and returns undefined", async () => {
		const { handler, fake, makeCtx } = await setup({ mode: "shadow" });

		expect(
			await handler(bashEvent('grep -rn "foo" extensions/'), makeCtx("/repo")),
		).toBeUndefined();
		expect(
			await handler(
				bashEvent("sed -i 's/a/b/' extensions/ce-core/index.ts"),
				makeCtx("/repo"),
			),
		).toBeUndefined();
		expect(fake.calls.length).toBe(0);
	});

	test("enforce: a deterministic violation blocks with a reason", async () => {
		const { handler, fake, makeCtx } = await setup({ mode: "enforce" });
		const result = await handler(
			bashEvent("sed -i 's/a/b/' extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("02-plan");
		expect(result?.reason).toContain("features.stageGuard.disabled");
		expect(fake.calls.length).toBe(0);
	});

	test("enforce: a Jev-derived mutating intent blocks", async () => {
		const { handler, makeCtx } = await setup({
			mode: "enforce",
			effect: "mutates_workspace",
			intent: true,
		});
		const result = await handler(bashEvent("python gen.py"), makeCtx("/repo"));

		expect(result?.block).toBe(true);
	});

	test("ambiguous commands call Jev once and dedupe by stage+repo+command", async () => {
		const { handler, fake, makeCtx } = await setup({ mode: "shadow" });

		await handler(bashEvent("python gen.py"), makeCtx("/repo"));
		await handler(bashEvent("python gen.py"), makeCtx("/repo"));
		expect(fake.calls.length).toBe(1);

		await handler(bashEvent('node -e "1"'), makeCtx("/repo"));
		expect(fake.calls.length).toBe(2);

		setActiveStage("03-work");
		await handler(bashEvent("python gen.py"), makeCtx("/repo"));
		expect(fake.calls.length).toBe(3);
	});

	test("a deterministic block is never weakened by an optimistic Jev answer", async () => {
		const { handler, fake, makeCtx } = await setup({
			mode: "enforce",
			effect: "read_only",
		});
		const result = await handler(
			bashEvent("rm extensions/ce-core/index.ts"),
			makeCtx("/repo"),
		);

		expect(result?.block).toBe(true);
		expect(fake.calls.length).toBe(0);
	});

	test("a Jev failure falls back to allow and notifies once", async () => {
		const { handler, notifyCalls, makeCtx } = await setup({
			mode: "shadow",
			error: true,
		});

		expect(await handler(bashEvent("python gen.py"), makeCtx("/repo"))).toBeUndefined();
		expect(await handler(bashEvent('node -e "1"'), makeCtx("/repo"))).toBeUndefined();
		expect(notifyCalls.length).toBe(1);
	});

	test("failClosed=true in enforce blocks when Jev is unavailable", async () => {
		const { handler, makeCtx } = await setup({
			mode: "enforce",
			failClosed: true,
			error: true,
		});
		const result = await handler(bashEvent("python gen.py"), makeCtx("/repo"));

		expect(result?.block).toBe(true);
	});

	test("off disables the bash guard but keeps the write/edit guard", async () => {
		const { handler, fake, makeCtx } = await setup({ mode: "off" });

		expect(
			await handler(bashEvent("rm extensions/ce-core/index.ts"), makeCtx("/repo")),
		).toBeUndefined();
		expect(fake.calls.length).toBe(0);
		expect(
			(await handler(writeEvent("extensions/ce-core/index.ts"), makeCtx("/repo")))
				?.block,
		).toBe(true);
	});

	test("features.stageGuard.disabled suppresses bash classification and logging", async () => {
		const repo = await makeRepo();
		setStartupFeaturesForTests(
			testFeatures({ stageGuard: { mode: "shadow", disabled: true } }),
		);
		const fake = fakeJev({});
		__setStageGuardJevFactory(() => fake);
		const { pi, eventHandlers, makeCtx } = createPiMock();
		ceCoreExtension(pi as never);
		setActiveStage("02-plan");
		const handler = eventHandlers.get("tool_call")![0];

		expect(
			await handler(bashEvent("rm extensions/ce-core/index.ts"), makeCtx(repo)),
		).toBeUndefined();
		expect(fake.calls.length).toBe(0);
		await expect(readFile(path.join(repo, GUARD_LOG_FILE), "utf8")).rejects.toThrow();
	});

	test("shadow logs one record per verdict without raw command text", async () => {
		const repo = await makeRepo();
		const { handler, makeCtx } = await setup({ mode: "shadow" });

		await handler(
			bashEvent("sed -i 's/a/b/' extensions/x.ts"),
			makeCtx(repo),
		);
		const lines = (await readFile(path.join(repo, GUARD_LOG_FILE), "utf8"))
			.trim()
			.split("\n");

		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect("command" in parsed).toBe(false);
		expect(lines[0]).not.toContain("s/a/b/");
	});

	test("off writes nothing to the shadow log in a real repo", async () => {
		const repo = await makeRepo();
		const { handler, makeCtx } = await setup({ mode: "off" });

		await handler(
			bashEvent("sed -i 's/a/b/' extensions/x.ts"),
			makeCtx(repo),
		);
		await expect(readFile(path.join(repo, GUARD_LOG_FILE), "utf8")).rejects.toThrow();
	});


	test("mutating-tool coverage: only write/edit/bash are intercepted", async () => {
		const { handler, registeredNames, fake, makeCtx } = await setup({
			mode: "shadow",
		});

		for (const name of registeredNames) {
			expect(["write", "edit", "bash"]).not.toContain(name);
			const result = await handler(
				{ type: "tool_call", toolName: name, input: {} },
				makeCtx("/repo"),
			);
			expect(result).toBeUndefined();
		}

		// bash is a Pi built-in, not a registered tool, yet it is intercepted...
		await handler(bashEvent("python gen.py"), makeCtx("/repo"));
		expect(fake.calls.length).toBe(1);
		// ...and write/edit keep their deterministic path guard.
		expect(
			(await handler(writeEvent("extensions/x.ts"), makeCtx("/repo")))?.block,
		).toBe(true);
	});
});
