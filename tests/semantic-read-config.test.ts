import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_SEMANTIC_READ,
	resolveSemanticReadConfig,
	validatePiPedstackConfig,
} from "../extensions/ce-core/utils/config-types";

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
	// no temp FS needed for config validation
});

describe("config-types — semanticRead", () => {
	test("parses a valid semanticRead block", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			semanticRead: {
				excerptBytes: 8192,
				maxPaths: 10,
				concurrency: 2,
				selectLimit: 5,
				deadlineMs: 1000,
				select: false,
			},
		});

		expect(config.semanticRead).toEqual({
			excerptBytes: 8192,
			maxPaths: 10,
			concurrency: 2,
			selectLimit: 5,
			deadlineMs: 1000,
			select: false,
		});
	});

	test("merges a partial config with defaults", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			semanticRead: { excerptBytes: 2048 },
		});

		expect(resolveSemanticReadConfig(config)).toEqual({
			...DEFAULT_SEMANTIC_READ,
			excerptBytes: 2048,
		});
	});

	test("no config resolves to the documented defaults", () => {
		expect(resolveSemanticReadConfig(null)).toEqual(DEFAULT_SEMANTIC_READ);
		expect(resolveSemanticReadConfig({})).toEqual(DEFAULT_SEMANTIC_READ);
		expect(DEFAULT_SEMANTIC_READ).toEqual({
			excerptBytes: 4096,
			maxPaths: 24,
			concurrency: 4,
			selectLimit: 12,
			deadlineMs: 45000,
			select: true,
		});
	});

	test("accepts maxPaths above 32 (clamped by the engine, not the config)", () => {
		const config = validatePiPedstackConfig({
			models: { default: { model: "cheap" } },
			semanticRead: { maxPaths: 100 },
		});

		expect(config.semanticRead?.maxPaths).toBe(100);
	});

	test("does not warn about the semanticRead key", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({
				models: { default: { model: "cheap" } },
				work: { model: "m" },
				semanticRead: { maxPaths: 2 },
			}),
		);

		expect(calls.filter((call) => call.includes("semanticRead"))).toEqual([]);
	});

	test("warns about unknown keys inside semanticRead", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({ models: { default: { model: "cheap" } }, semanticRead: { nope: 1 } }),
		);

		expect(calls.some((call) => call.includes("nope"))).toBe(true);
	});

	test("still warns about genuinely unknown top-level keys", () => {
		const calls = withWarnSpy(() =>
			validatePiPedstackConfig({ models: { default: { model: "cheap" } }, semanticRead: { maxPaths: 2 }, nonsense: 1 }),
		);

		expect(calls.some((call) => call.includes("nonsense"))).toBe(true);
	});

	test("rejects a non-object semanticRead", () => {
		expect(() => validatePiPedstackConfig({ semanticRead: 3 })).toThrow(
			/semanticRead/,
		);
	});

	test("rejects wrong-type and non-positive numeric fields", () => {
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { excerptBytes: "4096" } }),
		).toThrow(/semanticRead\.excerptBytes/);
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { maxPaths: 1.5 } }),
		).toThrow(/semanticRead\.maxPaths/);
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { concurrency: 0 } }),
		).toThrow(/semanticRead\.concurrency/);
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { selectLimit: -1 } }),
		).toThrow(/semanticRead\.selectLimit/);
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { deadlineMs: 0 } }),
		).toThrow(/semanticRead\.deadlineMs/);
		expect(() =>
			validatePiPedstackConfig({ semanticRead: { select: "yes" } }),
		).toThrow(/semanticRead\.select/);
	});
});
