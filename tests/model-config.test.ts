import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	readPiPedstackConfig,
	resolveModelRolesConfig,
	resolveRoutingConfig,
	validatePiPedstackConfig,
} from "../extensions/ce-core/utils/config-types";
import { DEFAULT_MODEL_ROUTING } from "../extensions/ce-core/utils/model-routing";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-model-config-"));
	tempRoots.push(root);
	return root;
}

function writeConfig(dir: string, relative: string, value: unknown): void {
	const configPath = path.join(dir, relative);
	mkdirSync(path.dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(value), "utf8");
}

function withWarnSpy(run: () => void): string[] {
	const calls: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		calls.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		run();
	} finally {
		console.warn = original;
	}
	return calls;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("config-types — models and routing", () => {
	test("parses a full models + routing block and round-trips", () => {
		const config = validatePiPedstackConfig({
			models: {
				default: { model: "cheap", thinkingLevel: "medium" },
				review: { model: "strong" },
				sota: { model: "strongest", thinkingLevel: "high" },
			},
			routing: {
				shadow: false,
				sotaMinScore: 0.7,
				sotaMinConfidence: 0.4,
				maxEscalationsPerStage: 2,
			},
		});

		expect(config.models).toEqual({
			default: { model: "cheap", thinkingLevel: "medium" },
			review: { model: "strong" },
			sota: { model: "strongest", thinkingLevel: "high" },
		});
		expect(config.routing).toEqual({
			shadow: false,
			sotaMinScore: 0.7,
			sotaMinConfidence: 0.4,
			maxEscalationsPerStage: 2,
		});
	});

	test("merges a partial routing block with DEFAULT_MODEL_ROUTING", () => {
		const config = validatePiPedstackConfig({
			routing: { sotaMinScore: 0.9 },
		});

		expect(resolveRoutingConfig(config)).toEqual({
			...DEFAULT_MODEL_ROUTING,
			sotaMinScore: 0.9,
		});
	});

	test("resolves partial models without inventing roles", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
		});

		expect(resolveModelRolesConfig(config)).toEqual({
			default: { model: "cheap" },
		});
	});

	test("documented defaults for a missing config", () => {
		expect(DEFAULT_MODEL_ROUTING).toEqual({
			sotaMinScore: 0.6,
			sotaMinConfidence: 0.5,
			maxEscalationsPerStage: 1,
			shadow: true,
		});
		expect(resolveModelRolesConfig(null)).toEqual({});
		expect(resolveModelRolesConfig({})).toEqual({});
		expect(resolveRoutingConfig(null)).toEqual(DEFAULT_MODEL_ROUTING);
		expect(resolveRoutingConfig({})).toEqual(DEFAULT_MODEL_ROUTING);
	});

	test("never warns about the models/routing keys", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({
				work: { model: "m" },
				models: { default: { model: "cheap" } },
				routing: { shadow: false },
			}),
		);

		expect(calls.filter((call) => call.includes("models"))).toEqual([]);
		expect(calls.filter((call) => call.includes("routing"))).toEqual([]);
	});

	test("warns about unknown keys inside models/routing", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({
				models: { default: { model: "cheap" }, nope: {} },
				routing: { shadow: false, nope: 1 },
			}),
		);

		expect(calls.some((call) => call.includes("models") && call.includes("nope"))).toBe(
			true,
		);
		expect(
			calls.some((call) => call.includes("routing") && call.includes("nope")),
		).toBe(true);
	});

	test("still warns about genuinely unknown top-level keys", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({
				models: { default: { model: "cheap" } },
				nonsense: 1,
			}),
		);

		expect(calls.some((call) => call.includes("nonsense"))).toBe(true);
	});

	test("rejects invalid routing values", () => {
		expect(() =>
			validatePiPedstackConfig({ routing: { sotaMinScore: 2 } }),
		).toThrow(/sotaMinScore/);
		expect(() =>
			validatePiPedstackConfig({ routing: { sotaMinConfidence: "x" } }),
		).toThrow(/sotaMinConfidence/);
		expect(() =>
			validatePiPedstackConfig({ routing: { maxEscalationsPerStage: 0 } }),
		).toThrow(/maxEscalationsPerStage/);
		expect(() =>
			validatePiPedstackConfig({ routing: { shadow: "yes" } }),
		).toThrow(/routing\.shadow/);
		expect(() => validatePiPedstackConfig({ routing: 3 })).toThrow(/routing/);
	});

	test("rejects invalid models values", () => {
		expect(() => validatePiPedstackConfig({ models: 3 })).toThrow(/models/);
		expect(() =>
			validatePiPedstackConfig({ models: { default: {} } }),
		).toThrow(/models\.default/);
		expect(() =>
			validatePiPedstackConfig({ models: { review: { model: 5 } } }),
		).toThrow(/models\.review/);
	});

	test("project-level config overrides the global config for models/routing", async () => {
		const repo = makeTempRoot();
		writeConfig(repo, ".pi/pi-pedstack/config.json", {
			models: { default: { model: "repo-cheap" } },
			routing: { shadow: false },
		});

		const config = await readPiPedstackConfig(repo);

		expect(config?.models?.default?.model).toBe("repo-cheap");
		expect(config?.routing?.shadow).toBe(false);
	});
});
