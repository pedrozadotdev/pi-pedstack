import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type {
	JevProcessOutput,
	JevRequest,
} from "../extensions/ce-core/jev/types";
import {
	__setModelRoutingJevFactory,
	cmdPedStart,
	resetPedstackState,
} from "../extensions/ce-core/commands/pedstack";

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

	test("a persisted escalate review action selects sota when shadow is false", async () => {
		const repo = makeRepo();
		writeConfig(repo, {
			models: {
				default: { model: "test/cheap" },
				sota: { model: "test/strong", thinkingLevel: "high" },
			},
			routing: { shadow: false },
		});
		const gateDir = path.join(
			repo,
			".context",
				"compound-engineering",
				"stage-gates",
		);
		mkdirSync(gateDir, { recursive: true });
		writeFileSync(
			path.join(gateDir, "01-brainstorm.json"),
			JSON.stringify({
				stage: "01-brainstorm",
				attempts: [
					{
						schema: 2,
						stage: "01-brainstorm",
						verdict: "review",
						enforcing: true,
						weightedScore: 0.5,
						det: [],
						sem: [],
						criticalFailed: false,
						jevUnavailable: false,
						jevReason: null,
						model: "typesafe/jev",
						warnings: [],
						artifacts: [],
						artifactsHash: "x",
						attempt: 0,
						updatedAt: "2026-10-05T00:00:00.000Z",
						review: {
							action: "escalate",
							reviewerCount: 0,
							reason: "independent review budget exhausted",
						},
					},
				],
			}),
			"utf8",
		);
		__setModelRoutingJevFactory(() => fakeJev(0.1));
		const harness = makeHarness(repo);

		await cmdPedStart(harness.pi).handler("build a CLI", harness.ctx);

		expect(harness.setModelCalls).toEqual([{ provider: "test", id: "strong" }]);
	});
});
