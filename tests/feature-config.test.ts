import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_FEATURES,
	readPiPedstackConfigSync,
	resolveFeaturesConfig,
	validatePiPedstackConfig,
} from "../extensions/ce-core/utils/config-types";

const roots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-feature-config-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("features config", () => {
	test("defaults enforce every feature while keeping fail-open booleans", () => {
		expect(resolveFeaturesConfig(null)).toEqual(DEFAULT_FEATURES);
	});

	test("partial feature overrides merge independently", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			features: {
				stageGate: { mode: "enforce" },
				docsVerification: { failClosed: true },
				compactionGuard: { live: true },
				stageGuard: { mode: "enforce", disabled: true },
			},
		});

		expect(resolveFeaturesConfig(config)).toEqual({
			...DEFAULT_FEATURES,
			stageGate: { mode: "enforce" },
			docsVerification: { mode: "enforce", failClosed: true },
			compactionGuard: { mode: "enforce", live: true },
			stageGuard: { mode: "enforce", failClosed: false, disabled: true },
		});
	});

	test("invalid feature mode is rejected instead of silently falling back", () => {
		expect(() =>
			validatePiPedstackConfig({
				features: { stageGate: { mode: "ENFORCE" } },
			}),
		).toThrow('features.stageGate.mode');
	});

	test("boolean feature options require booleans", () => {
		expect(() =>
			validatePiPedstackConfig({
				features: { driftGuard: { failClosed: "1" } },
			}),
		).toThrow('features.driftGuard.failClosed');
	});

	test("authoritative project config errors are not hidden by fallback", () => {
		const repo = makeRepo();
		const file = path.join(repo, ".pi", "pi-pedstack", "config.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ features: { stageGate: { mode: "ENFORCE" } } }),
			"utf8",
		);

		expect(() => readPiPedstackConfigSync(repo)).toThrow(
			"features.stageGate.mode",
		);
	});

	test("synchronous startup reader loads project feature policy", () => {
		const repo = makeRepo();
		const file = path.join(repo, ".pi", "pi-pedstack", "config.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				models: { default: { model: "cheap" } },
				features: {
					stageGate: { mode: "enforce" },
					stageGuard: { mode: "enforce", failClosed: true },
				},
			}),
			"utf8",
		);

		const config = readPiPedstackConfigSync(repo);
		expect(config).not.toBeNull();
		expect(resolveFeaturesConfig(config).stageGate.mode).toBe("enforce");
		expect(resolveFeaturesConfig(config).stageGuard).toEqual({
			mode: "enforce",
			failClosed: true,
			disabled: false,
		});
	});
});
