// Unit 1 — compaction-guard deterministic pressure facts and the tier→health
// bridge. Pure, no I/O, no Jev.
import { describe, expect, test } from "bun:test";
import {
	ENFORCE_JEV_TIMEOUT_MS,
	MAX_CONSECUTIVE_DEFERS,
	MAX_JEV_CALLS_PER_SESSION,
	MAX_LOG_BYTES,
	NOTICE_FLOOR,
	OVERAGE_TOKENS,
	PRIOR_SUMMARY_BYTES,
	RECENT_ENTRIES,
	RECENT_EXCERPT_BYTES,
	RECOMMEND_FLOOR,
	REQUEST_FLOOR,
	SHADOW_JEV_TIMEOUT_MS,
	computeFacts,
	deriveHealth,
	deriveTier,
} from "../extensions/ce-core/compaction-guard/facts.js";
import type { CompactionTier } from "../extensions/ce-core/compaction-guard/types.js";

const WINDOWS = [128_000, 200_000, 1_000_000];

describe("frozen config/limits", () => {
	test("pins the tier floors and overage budget", () => {
		expect(NOTICE_FLOOR).toBe(0.6);
		expect(RECOMMEND_FLOOR).toBe(0.75);
		expect(REQUEST_FLOOR).toBe(0.9);
		expect(OVERAGE_TOKENS).toBe(2_000);
	});

	test("pins the loop guards, budgets, and excerpt caps", () => {
		expect(MAX_CONSECUTIVE_DEFERS).toBe(2);
		expect(MAX_JEV_CALLS_PER_SESSION).toBe(12);
		expect(SHADOW_JEV_TIMEOUT_MS).toBe(2_000);
		expect(ENFORCE_JEV_TIMEOUT_MS).toBe(8_000);
		expect(MAX_LOG_BYTES).toBe(262_144);
		expect(RECENT_ENTRIES).toBe(6);
		expect(RECENT_EXCERPT_BYTES).toBe(512);
		expect(PRIOR_SUMMARY_BYTES).toBe(1_024);
	});
});

describe("deriveTier inclusive boundaries", () => {
	const cases: Array<[number | null, CompactionTier]> = [
		[0, "silent"],
		[0.599, "silent"],
		[0.6, "notice"],
		[0.749, "notice"],
		[0.75, "recommend"],
		[0.899, "recommend"],
		[0.9, "request"],
		[1, "request"],
		[null, "silent"],
	];

	for (const [pressure, tier] of cases) {
		test(`pressure ${pressure} → ${tier}`, () => {
			expect(deriveTier(pressure)).toBe(tier);
		});
	}
});

describe("deriveHealth one-directional bridge", () => {
	test("maps each tier to its health value", () => {
		expect(deriveHealth("silent")).toBe("good");
		expect(deriveHealth("notice")).toBe("watch");
		expect(deriveHealth("recommend")).toBe("heavy");
		expect(deriveHealth("request")).toBe("critical");
	});
});

describe("computeFacts single ownership", () => {
	test("derives trigger/headroom/overage/pressure/tier for a known window", () => {
		const facts = computeFacts({
			reason: "threshold",
			tokensBefore: 112_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
		});
		expect(facts.reason).toBe("threshold");
		expect(facts.contextWindow).toBe(128_000);
		expect(facts.triggerTokens).toBe(128_000 - 16_384);
		expect(facts.headroomTokens).toBe(16_384);
		expect(facts.overageTokens).toBe(112_000 - (128_000 - 16_384));
		expect(facts.pressure).toBeCloseTo(112_000 / 128_000, 10);
		expect(facts.tier).toBe("recommend");
	});

	test("keeps reserve headroom above the overage budget at every window size", () => {
		for (const contextWindow of WINDOWS) {
			const facts = computeFacts({
				reason: "threshold",
				tokensBefore: contextWindow - 16_384,
				contextWindow,
				reserveTokens: 16_384,
			});
			expect((facts.headroomTokens ?? 0) - OVERAGE_TOKENS).toBeGreaterThan(0);
		}
	});

	test("a null context window is silent with no pressure or overage", () => {
		const facts = computeFacts({
			reason: "threshold",
			tokensBefore: 100_000,
			contextWindow: null,
			reserveTokens: 16_384,
		});
		expect(facts.tier).toBe("silent");
		expect(facts.pressure).toBeNull();
		expect(facts.overageTokens).toBeNull();
		expect(facts.triggerTokens).toBeNull();
		expect(facts.headroomTokens).toBeNull();
	});

	test("zero and negative overage are preserved (defers only just past trigger)", () => {
		const at = computeFacts({
			reason: "threshold",
			tokensBefore: 111_616,
			contextWindow: 128_000,
			reserveTokens: 16_384,
		});
		expect(at.overageTokens).toBe(0);

		const below = computeFacts({
			reason: "threshold",
			tokensBefore: 100_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
		});
		expect(below.overageTokens).toBeLessThan(0);
	});

	test("preserves an unknown reason verbatim", () => {
		const facts = computeFacts({
			reason: "overflow",
			tokensBefore: 130_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
		});
		expect(facts.reason).toBe("overflow");
	});

	test("handles a very large window", () => {
		const facts = computeFacts({
			reason: "threshold",
			tokensBefore: 900_000,
			contextWindow: 10_000_000,
			reserveTokens: 16_384,
		});
		expect(facts.tier).toBe("silent");
		expect(facts.overageTokens).toBeLessThan(0);
	});

	test("a reserve larger than the window clamps trigger to zero without throwing", () => {
		const facts = computeFacts({
			reason: "threshold",
			tokensBefore: 50_000,
			contextWindow: 128_000,
			reserveTokens: 200_000,
		});
		expect(facts.triggerTokens).toBe(0);
		expect(facts.headroomTokens).toBe(128_000);
		expect(facts.overageTokens).toBe(50_000);
	});

	test("ignores non-finite inputs", () => {
		const facts = computeFacts({
			reason: "threshold",
			tokensBefore: Number.NaN,
			contextWindow: 128_000,
			reserveTokens: 16_384,
		});
		expect(facts.tokensBefore).toBeNull();
		expect(facts.overageTokens).toBeNull();
		expect(facts.pressure).toBeNull();
		expect(facts.tier).toBe("silent");
	});
});
