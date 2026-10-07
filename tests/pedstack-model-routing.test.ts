import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types";
import {
	__setModelRoutingJevFactory,
	cmdPedDebug,
	cmdPedFixIssues,
	cmdPedNext,
	cmdPedReload,
	cmdPedStart,
	resetPedstackState,
} from "../extensions/ce-core/commands/pedstack";
import { resolveStageRouting } from "../extensions/ce-core/utils/model-routing";
import {
	readRoutingRecord,
	writeRoutingRecord,
	type RoutingRecord,
} from "../extensions/ce-core/utils/routing-store";
import { stageGatePath } from "../extensions/ce-core/stage-gate/store";

const tempRoots: string[] = [];

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
	notifications: Array<{ message: string; level: string }>;
}

function makeHarness(repoRoot: string): Harness {
	const setModelCalls: Array<{ provider: string; id: string }> = [];
	const notifications: Array<{ message: string; level: string }> = [];

	const pi = {
		appendEntry: () => {},
		sendUserMessage: () => {},
		setModel: async (model: { provider: string; id: string }) => {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel: () => {},
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

	return { pi, ctx, setModelCalls, notifications };
}

afterEach(() => {
	__setModelRoutingJevFactory(null);
	resetPedstackState();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("switchStageConfig — stage-entry routing", () => {
	test("shadow mode logs the decision but applies only the legacy model", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
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
			stage: "03-work",
			jev,
		});
		const exhausted = await resolveStageRouting({
			repoRoot: repo,
			stage: "03-work",
			jev,
		});
		expect(first.decision.role).toBe("sota");
		expect(exhausted.decision.reason).toBe("budget_exhausted");

		const harness = makeHarness(repo);
		await cmdPedStart(harness.pi).handler("task B", harness.ctx);

		const fresh = await resolveStageRouting({
			repoRoot: repo,
			stage: "03-work",
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

describe("manual escalation via /ped-reload", () => {
	test("enforced /ped-reload applies models.sota from a persisted gate escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeContextState(repo, { currentStage: "03-work", nextStage: "04-review" });
		writeStageGateEscalate(repo, "03-work");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
		// /ped-reload must preserve the escalation signal that made this work.
		expect(existsSync(stageGatePath(repo, "03-work" as never))).toBe(true);
		const record = await readRoutingRecord(repo, "03-work");
		expect(record?.reason).toBe("gate_escalate");
		expect(record?.escalations).toBe(0);
	});

	test("shadow /ped-reload records gate_escalate but applies nothing", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: true } });
		writeContextState(repo, { currentStage: "03-work" });
		writeStageGateEscalate(repo, "03-work");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([]);
		const record = await readRoutingRecord(repo, "03-work");
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
			work: { model: "test/explicit" },
			models: MODELS,
			routing: { shadow: false },
		});
		writeContextState(repo, { currentStage: "03-work" });
		writeStageGateEscalate(repo, "03-work");
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedReload(harness.pi).handler("", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "explicit" }]);
		expect((await readRoutingRecord(repo, "03-work"))?.reason).toBe("override");
	});
});
