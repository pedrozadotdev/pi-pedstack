import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	readPiPedstackConfig,
	resolveSolutionRankingConfig,
	validatePiPedstackConfig,
} from "../extensions/ce-core/utils/config-types";
import { DEFAULT_SOLUTION_RANKING } from "../extensions/ce-core/utils/solution-ranking";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-config-"));
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

describe("config-types — solutionRanking", () => {
	test("parses a valid solutionRanking block", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			solutionRanking: {
				minRank: 0.7,
				minConfidence: 0.4,
				concurrency: 2,
				candidates: 20,
				limit: 5,
				shadow: false,
			},
		});

		expect(config.solutionRanking).toEqual({
			minRank: 0.7,
			minConfidence: 0.4,
			concurrency: 2,
			candidates: 20,
			limit: 5,
			shadow: false,
		});
	});

	test("merges a partial config with defaults", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			solutionRanking: { minRank: 0.9 },
		});

		expect(resolveSolutionRankingConfig(config)).toEqual({
			...DEFAULT_SOLUTION_RANKING,
			minRank: 0.9,
		});
	});

	test("does not warn about the solutionRanking key", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({
				models: { default: { model: "cheap" } },
				work: { model: "m" },
				solutionRanking: { limit: 2 },
			}),
		);

		expect(calls.filter((call) => call.includes("solutionRanking"))).toEqual([]);
	});

	test("still warns about genuinely unknown top-level keys", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({ models: { default: { model: "cheap" } }, solutionRanking: { limit: 2 }, nonsense: 1 }),
		);

		expect(calls.some((call) => call.includes("nonsense"))).toBe(true);
	});

	test("rejects non-object solutionRanking", () => {
		expect(() => validatePiPedstackConfig({ solutionRanking: 3 })).toThrow(
			/solutionRanking/,
		);
	});

	test("rejects non-numeric, out-of-range and wrong-type fields", () => {
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { minRank: "0.5" } }),
		).toThrow(/minRank/);
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { minConfidence: 2 } }),
		).toThrow(/minConfidence/);
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { concurrency: 0 } }),
		).toThrow(/concurrency/);
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { candidates: 1.5 } }),
		).toThrow(/candidates/);
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { limit: -1 } }),
		).toThrow(/limit/);
		expect(() =>
			validatePiPedstackConfig({ solutionRanking: { shadow: "yes" } }),
		).toThrow(/shadow/);
	});

	test("no config resolves to the documented defaults", () => {
		expect(resolveSolutionRankingConfig(null)).toEqual(DEFAULT_SOLUTION_RANKING);
		expect(resolveSolutionRankingConfig({})).toEqual(DEFAULT_SOLUTION_RANKING);
	});

	test("project-level config overrides the global config", async () => {
		// os.homedir() is cached per process, so the real global config is used as
		// the fallback here. The project config must win regardless.
		const repo = makeTempRoot();
		writeConfig(repo, ".pi/pi-pedstack/config.json", {
			models: { default: { model: "cheap" } },
			solutionRanking: { limit: 2 },
		});

		const config = await readPiPedstackConfig(repo);

		expect(config?.solutionRanking?.limit).toBe(2);
	});
});
