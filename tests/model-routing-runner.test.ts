import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types";
import { resolveStageRouting } from "../extensions/ce-core/utils/model-routing";
import { readRoutingRecord } from "../extensions/ce-core/utils/routing-store";
import { resetWorkflowRoutingState } from "../extensions/ce-core/utils/workflow-reset";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-routing-runner-"));
	tempRoots.push(root);
	return root;
}

function writeConfig(repoRoot: string, payload: Record<string, unknown>): void {
	const file = path.join(repoRoot, ".pi", "pi-pedstack", "config.json");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(payload), "utf8");
}

function writeStageGate(
	repoRoot: string,
	stage: string,
	attempt: Record<string, unknown>,
): void {
	writeStageGateAttempts(repoRoot, stage, [attempt]);
}

function writeStageGateAttempts(
	repoRoot: string,
	stage: string,
	attempts: Array<Record<string, unknown>>,
): void {
	const file = path.join(
		repoRoot,
		".context",
		"compound-engineering",
		"stage-gates",
		`${stage}.json`,
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ stage, attempts }), "utf8");
}

function routingHandler(
	options: { value?: number; confidence?: number } = {},
): (request: JevRequest) => JevProcessOutput {
	const value = options.value ?? 0.9;
	const { confidence } = options;
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			answers[id] =
				confidence === undefined
					? { type: "noul", noul: value }
					: { type: "noul", noul: value, confidence };
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify({ answers, model: "fake-jev" }),
			stderr: "",
		};
	};
}

const MODELS = {
	default: { model: "cheap", thinkingLevel: "medium" },
	sota: { model: "strong", thinkingLevel: "high" },
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resolveStageRouting — inert without config", () => {
	test("skips Jev entirely when neither models nor routing is configured", async () => {
		const repo = makeRepo();
		writeConfig(repo, { work: { model: "legacy" } });
		const jev = createFakeJevRuntime({
			handler: () => new Error("Jev must not be called"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(jev.requests.length).toBe(0);
		expect(result.appliedModel).toBeNull();
		expect(result.appliedThinkingLevel).toBeNull();
		expect(result.shadow).toBe(true);
		expect(result.decision.reason).toBe("fallback");
		expect(await readRoutingRecord(repo, "02-plan")).toBeNull();
	});
});

describe("resolveStageRouting — shadow mode", () => {
	test("computes and persists a decision but applies nothing", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: MODELS,
			routing: { shadow: true },
		});
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
			now: () => new Date("2026-10-06T00:00:00.000Z"),
		});

		expect(result.decision.role).toBe("sota");
		expect(result.decision.reason).toBe("jev");
		expect(result.shadow).toBe(true);
		expect(result.appliedModel).toBeNull();

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.role).toBe("sota");
		expect(record?.updatedAt).toBe("2026-10-06T00:00:00.000Z");
		// Shadow must not consume the escalation budget.
		expect(record?.escalations).toBe(0);
	});

	test("a deterministic gate escalate is recorded but never applied under shadow", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: true } });
		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "escalate",
		});
		const jev = createFakeJevRuntime({
			handler: () => new Error("Jev must not be called"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.decision.reason).toBe("gate_escalate");
		expect(result.shadow).toBe(true);
		expect(result.appliedModel).toBeNull();
		expect(jev.requests.length).toBe(0);

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.role).toBe("sota");
		expect(record?.reason).toBe("gate_escalate");
		// Shadow applies nothing, so it also consumes nothing.
		expect(record?.escalations).toBe(0);
	});
});

describe("resolveStageRouting — enforce mode", () => {
	test("qualifying Jev applies the sota role and records one escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({
			handler: routingHandler({ confidence: 0.9 }),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.appliedModel).toBe("strong");
		expect(result.appliedThinkingLevel).toBe("high");
		expect(jev.requests.length).toBe(1);

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.role).toBe("sota");
		expect(record?.escalations).toBe(1);
		expect(record?.attempts).toBe(0);
		expect(record?.revisions).toBe(0);
		expect(record?.reviews).toBe(0);
	});

	test("persists revision and review counters derived from retained attempts", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeStageGateAttempts(repo, "02-plan", [
			{ verdict: "revise" },
			{ verdict: "review" },
			{ verdict: "accept" },
		]);
		const jev = createFakeJevRuntime({
			handler: routingHandler({ value: 0.1, confidence: 0.9 }),
		});

		await resolveStageRouting({ repoRoot: repo, stage: "02-plan", jev });

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.attempts).toBe(3);
		expect(record?.revisions).toBe(1);
		expect(record?.reviews).toBe(1);
	});

	test("non-qualifying Jev applies the default role", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({
			handler: routingHandler({ value: 0.1, confidence: 0.9 }),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("default");
		expect(result.decision.reason).toBe("fallback");
		expect(result.appliedModel).toBe("cheap");
		expect(result.appliedThinkingLevel).toBe("medium");
	});

	test("a newest stage-gate escalate skips Jev deterministically", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "escalate",
		});
		const jev = createFakeJevRuntime({
			handler: () => new Error("Jev must not be called"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.decision.reason).toBe("gate_escalate");
		expect(result.appliedModel).toBe("strong");
		expect(jev.requests.length).toBe(0);
	});

	test("a Jev failure degrades to the default role without throwing", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({
			handler: () => new Error("timeout"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.reason).toBe("fallback");
		expect(result.decision.source).toBe("fallback");
		expect(result.appliedModel).toBe("cheap");
	});

	test("an explicit override wins and applies nothing (caller applies it)", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({
			handler: () => new Error("Jev must not be called"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			override: { model: "explicit" },
			jev,
		});

		expect(result.decision.reason).toBe("override");
		expect(result.decision.overrideModel).toBe("explicit");
		expect(result.appliedModel).toBeNull();
		expect(jev.requests.length).toBe(0);
	});

	test("the escalation budget is exhausted on a second enforcing run", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const first = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		const second = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(first.decision.role).toBe("sota");
		expect(second.decision.role).toBe("default");
		expect(second.decision.reason).toBe("budget_exhausted");
		expect(second.decision.source).toBe("budget");
		expect(second.appliedModel).toBe("cheap");

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.reason).toBe("budget_exhausted");
		expect(record?.reason).not.toBe("fallback");
		expect(record?.escalations).toBe(1);
	});

	test("a raised maxEscalationsPerStage allows a second escalation", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: MODELS,
			routing: { shadow: false, maxEscalationsPerStage: 2 },
		});
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const first = await resolveStageRouting({ repoRoot: repo, stage: "02-plan", jev });
		const second = await resolveStageRouting({ repoRoot: repo, stage: "02-plan", jev });
		const third = await resolveStageRouting({ repoRoot: repo, stage: "02-plan", jev });

		expect(first.decision.role).toBe("sota");
		expect(second.decision.role).toBe("sota");
		expect(third.decision.role).toBe("default");
		expect(third.decision.reason).toBe("budget_exhausted");

		const record = await readRoutingRecord(repo, "02-plan");
		expect(record?.escalations).toBe(2);
	});
});

describe("resolveStageRouting — budget semantics", () => {
	test("a deterministic gate escalate is honored after the proactive Jev budget is spent", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		// The first run consumes the single configured proactive Jev escalation.
		const first = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		expect(first.decision.reason).toBe("jev");

		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "escalate",
		});
		const escalated = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(escalated.decision.role).toBe("sota");
		expect(escalated.decision.reason).toBe("gate_escalate");
		expect(escalated.appliedModel).toBe("strong");
	});

	test("a deterministic gate escalate does not consume the proactive Jev budget", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "escalate",
		});
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const escalated = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		expect(escalated.decision.reason).toBe("gate_escalate");
		expect(jev.requests.length).toBe(0);
		expect((await readRoutingRecord(repo, "02-plan"))?.escalations).toBe(0);

		// Clear the gate escalation; the proactive Jev budget must still be available.
		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "accept",
		});
		const routed = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(routed.decision.role).toBe("sota");
		expect(routed.decision.reason).toBe("jev");
	});

	test("models.review is never applied as an execution model", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: { review: { model: "reviewer" } },
			routing: { shadow: false },
		});
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.appliedModel).toBeNull();
		expect(result.appliedModel).not.toBe("reviewer");
	});
});

describe("resolveStageRouting — partial role config", () => {
	test("routing without models still computes but applies nothing", async () => {
		const repo = makeRepo();
		writeConfig(repo, { routing: { shadow: false } });
		const jev = createFakeJevRuntime({ handler: routingHandler() });

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.appliedModel).toBeNull();
		expect(await readRoutingRecord(repo, "02-plan")).not.toBeNull();
	});

	test("a gate escalate with no sota role falls back to default, never review", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "cheap" },
				review: { model: "reviewer" },
			},
			routing: { shadow: false },
		});
		writeStageGate(repo, "02-plan", {
			schema: 1,
			stage: "02-plan",
			verdict: "escalate",
		});
		const jev = createFakeJevRuntime({
			handler: () => new Error("Jev must not be called"),
		});

		const result = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});

		expect(result.decision.role).toBe("sota");
		expect(result.appliedModel).toBe("cheap");
		expect(result.appliedModel).not.toBe("reviewer");
	});

	test("a workflow reset restores the proactive Jev budget", async () => {
		const repo = makeRepo();
		writeConfig(repo, { models: MODELS, routing: { shadow: false } });
		const jev = createFakeJevRuntime({ handler: routingHandler() });

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

		await resetWorkflowRoutingState(repo);

		const fresh = await resolveStageRouting({
			repoRoot: repo,
			stage: "02-plan",
			jev,
		});
		expect(fresh.decision.role).toBe("sota");
		expect(fresh.decision.reason).toBe("jev");
	});
});

describe("resolveStageRouting — no SOTA for execution and closing stages", () => {
	for (const stage of ["03-work", "04-review", "05-learn", "06-docsync"]) {
		for (const shadow of [true, false]) {
			test(`${stage}: ignores stale escalations in shadow=${shadow}`, async () => {
				const repo = makeRepo();
				writeConfig(repo, { models: MODELS, routing: { shadow } });
				writeStageGate(repo, stage, { schema: 1, stage, verdict: "escalate" });
				const jev = createFakeJevRuntime({ handler: () => new Error("Jev must not be called") });
				const routed = await resolveStageRouting({ repoRoot: repo, stage, jev });
				expect(routed.decision.role).toBe("default");
				expect(routed.decision.reason).toBe("stage_policy");
				expect(routed.appliedModel).toBe(shadow ? null : "cheap");
				expect(jev.requests).toHaveLength(0);
				expect((await readRoutingRecord(repo, stage))?.escalations).toBe(0);
			});
		}
		test(`${stage}: explicit operator override is preserved`, async () => {
			const repo = makeRepo();
			writeConfig(repo, { models: MODELS, routing: { shadow: false } });
			const jev = createFakeJevRuntime({ handler: () => new Error("Jev must not be called") });
			const routed = await resolveStageRouting({ repoRoot: repo, stage, override: { model: "operator/model" }, jev });
			expect(routed.decision.reason).toBe("override");
			expect(routed.decision.overrideModel).toBe("operator/model");
			expect(jev.requests).toHaveLength(0);
		});
	}
});
