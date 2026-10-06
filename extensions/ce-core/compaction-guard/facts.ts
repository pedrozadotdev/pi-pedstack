// Deterministic pressure facts for the semantic compaction guard (plan Unit 1;
// AD-1/AD-3). Pure: no I/O, no Jev. `facts.ts` is the single owner of every
// threshold, the overage math, and the tier→health bridge; `store.ts` never
// recomputes overage and the hook path never calls `deriveTier`.

import type { CompactionFacts, CompactionTier, ContextHealth } from "./types";

// ── Frozen config/limits (plan "Frozen config/limits") ─────────────
/** Tier boundary at the provider only (AD-3). */
export const NOTICE_FLOOR = 0.6;
/** Tier boundary at the provider only (AD-3). */
export const RECOMMEND_FLOOR = 0.75;
/** Tier boundary at the provider only (AD-3). */
export const REQUEST_FLOOR = 0.9;
/** Defers only just past trigger (~12% of the 16384 reserve). */
export const OVERAGE_TOKENS = 2_000;
/** At most two reschedules per episode, then allow. */
export const MAX_CONSECUTIVE_DEFERS = 2;
/** Threshold checks are rare; bounds worst case at ~24s shadow / ~96s enforce. */
export const MAX_JEV_CALLS_PER_SESSION = 12;
/** Keeps the awaited hook cheap during calibration (AD-2). */
export const SHADOW_JEV_TIMEOUT_MS = 2_000;
/** Matches the drift guard's bound. */
export const ENFORCE_JEV_TIMEOUT_MS = 8_000;
/** Compaction log lines are smaller and rarer than the drift log (1 MiB). */
export const MAX_LOG_BYTES = 262_144;
/** Semantic state excerpt count. */
export const RECENT_ENTRIES = 6;
/** Per-entry excerpt cap. */
export const RECENT_EXCERPT_BYTES = 512;
/** Previous-summary excerpt cap. */
export const PRIOR_SUMMARY_BYTES = 1_024;
/** Per-answer floor (not a value threshold). */
export const MIN_CONFIDENCE = 0.5;
/** Matches the Jev validator cap; conformance-tested. */
export const MAX_REQUEST_BODY_BYTES = 65_536;

function toFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Inclusive-floor tier from a pressure ratio. A missing window/pressure is
 * `silent` (no Jev eligibility), never a guessed tier.
 */
export function deriveTier(pressure: number | null): CompactionTier {
	if (pressure === null) return "silent";
	if (pressure < NOTICE_FLOOR) return "silent";
	if (pressure < RECOMMEND_FLOOR) return "notice";
	if (pressure < REQUEST_FLOOR) return "recommend";
	return "request";
}

/** One-directional tier→health bridge (AD-6). */
export function deriveHealth(tier: CompactionTier): ContextHealth {
	switch (tier) {
		case "silent":
			return "good";
		case "notice":
			return "watch";
		case "recommend":
			return "heavy";
		case "request":
			return "critical";
	}
}

export interface CompactionFactsInput {
	reason?: unknown;
	tokensBefore?: unknown;
	contextWindow?: unknown;
	reserveTokens?: unknown;
}

/**
 * Compute overage/trigger/headroom/pressure and the tier. A non-finite or
 * absent window yields nulls plus the `silent` tier; a reserve larger than the
 * window clamps the trigger to zero (defensive, never throws).
 */
export function computeFacts(input: CompactionFactsInput): CompactionFacts {
	const reason = typeof input.reason === "string" ? input.reason : "unknown";
	const tokensBefore = toFiniteNumber(input.tokensBefore);
	const contextWindow = toFiniteNumber(input.contextWindow);
	const reserveTokens = toFiniteNumber(input.reserveTokens) ?? 0;

	if (contextWindow === null || contextWindow <= 0) {
		return {
			reason,
			tokensBefore,
			contextWindow: null,
			triggerTokens: null,
			headroomTokens: null,
			overageTokens: null,
			pressure: null,
			tier: "silent",
		};
	}

	const triggerTokens = Math.max(0, contextWindow - reserveTokens);
	const headroomTokens = Math.max(0, contextWindow - triggerTokens);
	const overageTokens =
		tokensBefore === null ? null : tokensBefore - triggerTokens;
	const pressure = tokensBefore === null ? null : tokensBefore / contextWindow;

	return {
		reason,
		tokensBefore,
		contextWindow,
		triggerTokens,
		headroomTokens,
		overageTokens,
		pressure,
		tier: deriveTier(pressure),
	};
}
