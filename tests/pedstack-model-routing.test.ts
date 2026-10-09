import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types";
import {
	__setModelRoutingJevFactory,
	__setWorkflowReset,
	cmdPedDebug,
	cmdPedFixIssues,
	cmdPedNext,
	cmdPedReload,
	cmdPedStart,
	resetPedstackState,
} from "../extensions/ce-core/commands/pedstack";
import { resolveStageRouting } from "../extensions/ce-core/utils/model-routing";
import {
	clearRoutingRecords,
	readRoutingRecord,
	writeRoutingRecord,
	type RoutingRecord,
} from "../extensions/ce-core/utils/routing-store";
import { resetWorkflowRoutingState } from "../extensions/ce-core/utils/workflow-reset";
import { stageGatePath } from "../extensions/ce-core/stage-gate/store";
import { __resetDiagnosticsForTests, shutdownDiagnostics } from "../extensions/ce-core/diagnostics";
import {
	getActiveStage,
	setActiveStage,
} from "../extensions/ce-core/utils/active-stage";

const tempRoots: string[] = [];
const previousDiagnosticsFile = process.env.PEDSTACK_DIAGNOSTICS_FILE;

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-pedstack-routing-"));
	tempRoots.push(root);
	return root;
}

function writeConfig(repoRoot: string, payload: Record<string, unknown>): void {
	const file = path.join(repoRoot, ".pi", "pi-pedstack", "config.json");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(payload), "utf8");
}

function writeContextState(
	repoRoot: string,
	state: Record<string, unknown>,
): void {
	const file = path.join(
		repoRoot,
		".context",
		"compound-engineering",
		"context-state.json",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state), "utf8");
}

function writeStageGateEscalate(repoRoot: string, stage: string): void {
	const file = stageGatePath(repoRoot, stage as never);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			stage,
			attempts: [{ schema: 2, stage, verdict: "escalate", enforcing: true }],
		}),
		"utf8",
	);
}

function writeRouting(
	repoRoot: string,
	stage: string,
	escalations: number,
): Promise<string> {
	const record: RoutingRecord = {
		schema: 1,
		stage,
		role: "sota",
		reason: "jev",
		source: "jev",
		scores: null,
		weighted: 0.9,
		confidence: 0.9,
		attempts: 0,
		escalations,
		revisions: 0,
		reviews: 0,
		updatedAt: "2026-10-06T00:00:00.000Z",
	};
	return writeRoutingRecord(repoRoot, record);
}

const MODELS = {
	default: { model: "cheap", thinkingLevel: "medium" },
	sota: { model: "strong", thinkingLevel: "high" },
};

function fakeJev(value = 0.9) {
	return createFakeJevRuntime({
		handler: (request: JevRequest): JevProcessOutput => {
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(request.questions)) {
				answers[id] = { type: "noul", noul: value, confidence: 0.9 };
			}
			return {
				exitCode: 0,
				stdout: JSON.stringify({ answers, model: "fake-jev" }),
				stderr: "",
			};
		},
	});
}

interface Harness {
	pi: any;
	ctx: any;
	setModelCalls: Array<{ provider: string; id: string }>;
	setThinkingLevelCalls: string[];
	notifications: Array<{ message: string; level: string }>;
	appendCalls: Array<{ type: string; data: any }>;
	sentMessages: any[];
}

function makeHarness(repoRoot: string): Harness {
	const setModelCalls: Array<{ provider: string; id: string }> = [];
	const setThinkingLevelCalls: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const appendCalls: Array<{ type: string; data: any }> = [];
	const sentMessages: any[] = [];

	const pi = {
		appendEntry: (type: string, data?: any) => {
			appendCalls.push({ type, data });
		},
		sendUserMessage: (content: any) => {
			sentMessages.push(content);
		},
		setModel: async (model: { provider: string; id: string }) => {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel: (level: string) => {
			setThinkingLevelCalls.push(level);
		},
		getThinkingLevel: () => "medium",
	} as any;

	const ctx = {
		hasUI: true,
		cwd: repoRoot,
		sessionManager: {
			getLeafId: () => "leaf-1",
			getBranch: () => [
				{ type: "message", id: "msg-1", parentId: "root-1" },
			],
		},
		model: { provider: "test", id: "current" },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level: level ?? "info" });
			},
		},
		navigateTree: async () => ({ cancelled: false }),
		waitForIdle: async () => {},
	} as any;

	return {
		pi,
		ctx,
		setModelCalls,
		setThinkingLevelCalls,
		notifications,
		appendCalls,
		sentMessages,
	};
}

afterEach(async () => {
	__setModelRoutingJevFactory(null);
	__setWorkflowReset(null);
	resetPedstackState();
	delete process.env.PEDSTACK_DIAGNOSTICS_FILE;
	if (previousDiagnosticsFile !== undefined) process.env.PEDSTACK_DIAGNOSTICS_FILE = previousDiagnosticsFile;
	setActiveStage(null);
	await shutdownDiagnostics();
	await __resetDiagnosticsForTests();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function runEscalatedReload(options: {
	shadow: boolean;
	setModel?: (model: { provider: string; id: string }) => Promise<boolean>;
	findModel?: (provider: string, id: string) => unknown;
}): Promise<{ harness: Harness; rows: Array<Record<string, unknown>> }> {
	const repo = makeRepo();
	const diagnosticsFile = path.join(repo, "routing.jsonl");
	process.env.PEDSTACK_DIAGNOSTICS_FILE = diagnosticsFile;
	await __resetDiagnosticsForTests();
	writeConfig(repo, { models: MODELS, routing: { shadow: options.shadow } });
	writeContextState(repo, { currentStage: "02-plan", nextStage: "03-work" });
	writeStageGateEscalate(repo, "02-plan");
	__setModelRoutingJevFactory(() => fakeJev(0.1));
	const harness = makeHarness(repo);
	if (options.setModel) harness.pi.setModel = options.setModel;
	if (options.findModel) harness.ctx.modelRegistry.find = options.findModel;
	await cmdPedReload(harness.pi).handler("", harness.ctx);
	await shutdownDiagnostics();
	const rows = (await readFile(diagnosticsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	return { harness, rows };
}

describe("switchStageConfig — stage-entry routing", () => {
	test("shadow mode logs the decision but applies only the legacy model", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: MODELS,
			brainstorm: { model: "test/legacy" },
			routing: { shadow: true },
		});
		__setModelRoutingJevFactory(() => fakeJev());
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "legacy" }]);
		expect(
			harness.notifications.some(
				(n) => n.level === "info" && n.message.includes("[routing]"),
			),
		).toBe(true);
	});

	test("enforce applies models.default when Jev does not qualify", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap", thinkingLevel: "medium" },
				sota: { model: "test/strong" },
			},
			routing: { shadow: false },
		});
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "cheap" }]);
	});

	test("enforce applies max thinkingLevel from models.default", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap", thinkingLevel: "max" },
				sota: { model: "test/strong", thinkingLevel: "max" },
			},
			routing: { shadow: false },
		});
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "cheap" }]);
		expect(harness.setThinkingLevelCalls).toEqual(["max"]);
	});

	test("an explicit per-stage model overrides the role model", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			brainstorm: { model: "test/explicit" },
			models: {
				default: { model: "test/cheap" },
				sota: { model: "test/strong" },
			},
			routing: { shadow: false },
		});
		__setModelRoutingJevFactory(() => fakeJev());
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "explicit" }]);
	});

	test("enforce applies the sota role via an injected fake Jev runtime", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap" },
				sota: { model: "test/strong", thinkingLevel: "high" },
			},
			routing: { shadow: false },
		});
		const fake = fakeJev(0.9);
		__setModelRoutingJevFactory(() => fake);
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
		expect(fake.requests.length).toBe(1);
	});

	test("enforce applies max thinkingLevel from models.sota", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap", thinkingLevel: "max" },
				sota: { model: "test/strong", thinkingLevel: "max" },
			},
			routing: { shadow: false },
		});
		__setModelRoutingJevFactory(() => fakeJev(0.9));
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
		expect(harness.setThinkingLevelCalls).toEqual(["max"]);
	});

	test("a throwing Jev factory degrades to the default role without rejecting", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap" },
				sota: { model: "test/strong" },
			},
			routing: { shadow: false },
		});
		__setModelRoutingJevFactory(() => {
			throw new Error("factory exploded");
		});
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "cheap" }]);
	});
});

describe("workflow budget lifecycle", () => {
	test("a new /ped-start clears the previous workflow's budget and gate records", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(false);
	});

	test("a new /ped-fix-issues clears the previous workflow's budget", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		const harness = makeHarness(repo);

		await cmdPedFixIssues(harness.pi).handler("#12", harness.ctx);

		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
	});

	test("/ped-next does not clear the prior routing budget", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		const harness = makeHarness(repo);

		await cmdPedNext(harness.pi).handler("", harness.ctx);

		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
	});

	test("/ped-debug does not clear prior workflow state", async () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentStage: "04-review",
			nextStage: "05-learn",
		});
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		const harness = makeHarness(repo);

		await cmdPedDebug(harness.pi).handler("debug the failure", harness.ctx);

		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);
	});

	test("a second independent /ped-start workflow receives a fresh proactive budget", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = fakeJev();
		__setModelRoutingJevFactory(() => jev);

		const first = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		const exhausted = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		expect(first.decision.role).toBe("sota");
		expect(exhausted.decision.reason).toBe("budget_exhausted");

		const harness = makeHarness(repo);
		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		const fresh = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		expect(fresh.decision.role).toBe("sota");
		expect(fresh.decision.reason).toBe("jev");
	});

	test("a new workflow does not inherit a stale gate escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeStageGateEscalate(repo, "01-brainstorm");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		// The stale escalate is gone, so the low Jev judgment routes the default.
		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "cheap" }]);
		const record = await readRoutingRecord(repo, "01-brainstorm");
		expect(record?.reason).toBe("fallback");
	});
});

describe("workflow-root reset failure handling", () => {
	test("/ped-start aborts and preserves prior state when the reset fails", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		setActiveStage("03-work");
		__setWorkflowReset(async () => {
			throw new Error("reset unavailable");
		});
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		expect(harness.appendCalls).toEqual([]);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
		expect(getActiveStage()).toBe("03-work");
		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);
		expect(
			harness.notifications.some(
				(n) => n.level === "error" && n.message.includes("reset unavailable"),
			),
		).toBe(true);
	});

	test("/ped-fix-issues aborts and preserves prior state when the reset fails", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		setActiveStage("03-work");
		__setWorkflowReset(async () => {
			throw new Error("reset unavailable");
		});
		const harness = makeHarness(repo);

		await cmdPedFixIssues(harness.pi).handler("#12", harness.ctx);

		expect(harness.appendCalls).toEqual([]);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
		expect(getActiveStage()).toBe("03-work");
		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);
		expect(
			harness.notifications.some(
				(n) => n.level === "error" && n.message.includes("reset unavailable"),
			),
		).toBe(true);
	});

	test("a retry after a failed reset starts the workflow normally", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		__setWorkflowReset(async () => {
			throw new Error("reset unavailable");
		});
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);
		expect(harness.appendCalls).toEqual([]);

		__setWorkflowReset(null);
		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		expect(harness.appendCalls.map((c) => c.type)).toEqual([
			"ped-workflow-start",
			"ped-stage-start",
		]);
		expect(harness.appendCalls[1].data.stage).toBe("01-brainstorm");
		expect(harness.sentMessages).toEqual(["task B"]);
		expect(getActiveStage()).toBe("01-brainstorm");
		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(false);
	});

	test("a partial reset failure still aborts and a retry completes the reset", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		__setWorkflowReset(async (repoRoot) => {
			await clearRoutingRecords(repoRoot);
			throw new Error("stage-gate reset failed");
		});
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		// No workflow may start, even when part of the reset succeeded.
		expect(harness.appendCalls).toEqual([]);
		expect(harness.sentMessages).toEqual([]);
		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);

		__setWorkflowReset(null);
		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(false);
		expect(harness.appendCalls.map((c) => c.type)).toEqual([
			"ped-workflow-start",
			"ped-stage-start",
		]);
	});

	test("/ped-start resets prior state before initializing the new workflow", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		const resetCalls: string[] = [];
		__setWorkflowReset(async (repoRoot) => {
			resetCalls.push(repoRoot);
			await resetWorkflowRoutingState(repoRoot);
		});
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		expect(resetCalls).toEqual([repo]);
		expect(harness.appendCalls.map((c) => c.type)).toEqual([
			"ped-workflow-start",
			"ped-stage-start",
		]);
		expect(harness.appendCalls[0].data.anchorLeafId).toBe("leaf-1");
		expect(harness.sentMessages).toEqual(["task B"]);
		expect(getActiveStage()).toBe("01-brainstorm");
		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(false);
	});

	test("/ped-fix-issues resets prior state before initializing 01-brainstorm", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		const resetCalls: string[] = [];
		__setWorkflowReset(async (repoRoot) => {
			resetCalls.push(repoRoot);
			await resetWorkflowRoutingState(repoRoot);
		});
		const harness = makeHarness(repo);

		await cmdPedFixIssues(harness.pi).handler("#12", harness.ctx);

		expect(resetCalls).toEqual([repo]);
		expect(harness.appendCalls.map((c) => c.type)).toEqual([
			"ped-workflow-start",
			"ped-stage-start",
		]);
		expect(harness.appendCalls[1].data.stage).toBe("01-brainstorm");
		expect(harness.sentMessages.length).toBe(1);
		expect(harness.sentMessages[0]).toContain("Fetch GitHub issues #12");
		expect(getActiveStage()).toBe("01-brainstorm");
		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(false);
	});

	test("/ped-next transitions stages without invoking the workflow reset", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGateEscalate(repo, "03-work");
		writeContextState(repo, {
			currentStage: "01-brainstorm",
			nextStage: "02-plan",
		});
		let resetCalls = 0;
		__setWorkflowReset(async () => {
			resetCalls += 1;
		});
		const harness = makeHarness(repo);

		await cmdPedNext(harness.pi).handler("", harness.ctx);

		expect(resetCalls).toBe(0);
		expect(harness.appendCalls.map((c) => c.type)).toEqual(["ped-stage-start"]);
		expect(harness.appendCalls[0].data.stage).toBe("02-plan");
		expect(harness.sentMessages).toEqual(["Stage: 02-plan"]);
		expect(getActiveStage()).toBe("02-plan");
		// The prior workflow's budget and gate verdict survive continuation.
		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);
	});

	test("/ped-reload never invokes the workflow reset", async () => {
		const repo = makeRepo();
		writeContextState(repo, { currentStage: "03-work" });
		await writeRouting(repo, "03-work", 1);
		let resetCalls = 0;
		__setWorkflowReset(async () => {
			resetCalls += 1;
		});
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(resetCalls).toBe(0);
		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
	});

	test("/ped-debug never invokes the workflow reset", async () => {
		const repo = makeRepo();
		writeContextState(repo, {
			currentStage: "04-review",
			nextStage: "05-learn",
		});
		await writeRouting(repo, "03-work", 1);
		let resetCalls = 0;
		__setWorkflowReset(async () => {
			resetCalls += 1;
		});
		const harness = makeHarness(repo);

		await cmdPedDebug(harness.pi).handler("debug the failure", harness.ctx);

		expect(resetCalls).toBe(0);
		expect((await readRoutingRecord(repo, "03-work"))?.escalations).toBe(1);
	});
});

describe("manual escalation via /ped-reload", () => {
	test("diagnostics distinguish shadow recommendations from applied SOTA", async () => {
		const { harness, rows } = await runEscalatedReload({ shadow: true });
		expect(harness.setModelCalls).toEqual([]);
		expect(rows).toContainEqual(expect.objectContaining({ event: "role_selected", role: "sota" }));
		expect(rows.some((row) => row.event === "role_applied" && row.role === "sota")).toBe(false);
	});

	test("diagnostics record SOTA after an enforced reload successfully switches models", async () => {
		const { harness, rows } = await runEscalatedReload({ shadow: false });
		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
		expect(rows).toContainEqual(expect.objectContaining({
			event: "role_applied", stage: "02-plan", role: "sota", outcome: "success",
		}));
	});

	test("diagnostics reject SOTA when the model is unavailable", async () => {
		const { rows } = await runEscalatedReload({ shadow: false, findModel: () => undefined });
		expect(rows).toContainEqual(expect.objectContaining({
			event: "role_apply_failed", role: "sota", outcome: "failure", routingApplyFailure: "model_unavailable",
		}));
		expect(rows.some((row) => row.event === "role_applied" && row.role === "sota")).toBe(false);
	});

	test("diagnostics reject SOTA when the provider refuses model activation", async () => {
		const { rows } = await runEscalatedReload({ shadow: false, setModel: async () => false });
		expect(rows).toContainEqual(expect.objectContaining({
			event: "role_apply_failed", role: "sota", outcome: "failure", routingApplyFailure: "api_key",
		}));
		expect(rows.some((row) => row.event === "role_applied" && row.role === "sota")).toBe(false);
	});

	test("enforced /ped-reload applies models.sota from a persisted gate escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeContextState(repo, { currentStage: "02-plan", nextStage: "03-work" });
		writeStageGateEscalate(repo, "02-plan");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
		// /ped-reload must preserve the escalation signal that made this work.
		expect(existsSync(stageGatePath(repo, "02-plan" as never))).toBe(true);
		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.reason).toBe("gate_escalate");
		expect(record?.escalations).toBe(0);
	});

	test("shadow /ped-reload records gate_escalate but applies nothing", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: true } });
		writeContextState(repo, { currentStage: "02-plan" });
		writeStageGateEscalate(repo, "02-plan");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([]);
		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.role).toBe("sota");
		expect(record?.reason).toBe("gate_escalate");
		expect(record?.escalations).toBe(0);
		expect(
			harness.notifications.some((n) =>
				n.message.includes("shadow mode, not applied"),
			),
		).toBe(true);
	});

	test("an explicit per-stage override wins over the gate escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			plan: { model: "test/explicit" },
			models: MODELS,
			routing: { shadow: false },
		});
		writeContextState(repo, { currentStage: "02-plan" });
		writeStageGateEscalate(repo, "02-plan");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "explicit" }]);
		expect((await readRoutingRecord(repo, "02-plan"))?.reason).toBe("override");
	});
});

describe("manual reload ignores legacy restricted-stage gate escalation", () => {
	for (const stage of ["03-work", "04-review", "05-learn", "06-docsync"]) {
		test(`/ped-reload keeps ${stage} on default despite stale gate escalation`, async () => {
			const repo = makeRepo();
			writeConfig(repo, { models: MODELS, routing: { shadow: false } });
			writeContextState(repo, { currentStage: stage });
			writeStageGateEscalate(repo, stage);
			__setModelRoutingJevFactory(() => fakeJev(0.9));
			const harness = makeHarness(repo);
			await cmdPedReload(harness.pi).handler("", harness.ctx);
			expect(harness.setModelCalls).toEqual([{ provider: "test", id: "cheap" }]);
			expect((await readRoutingRecord(repo, stage))?.reason).toBe("stage_policy");
		});
	}
});
