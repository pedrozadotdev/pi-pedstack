// Frozen types for the semantic compaction guard (#11, Milestone D).
// Namespaced under `compaction-guard/` so nothing collides with the drift
// guard, handoff-readiness, or stage-gate verdicts (AD-1).

/** Operator-resolved compaction mode. Env is the only resolution layer (AD-9). */
export type CompactionMode = "off" | "shadow" | "enforce";

/** Deterministic token-pressure tier (AD-6). */
export type CompactionTier = "silent" | "notice" | "recommend" | "request";

/** TypeScript-derived action; only `defer` cancels a Pi auto-compaction. */
export type CompactionAction = "allow" | "defer";

/**
 * Provenance of a decision:
 * - `jev` — derived from a bounded Jev answer set (the only fresh source).
 * - `deterministic` — a pre-pass/dedupe short-circuit (no Jev call).
 * - `degraded` — Jev was unavailable or returned an unusable answer set.
 */
export type CompactionSource = "jev" | "deterministic" | "degraded";

/** Pressure-only handoff health (AD-6). Never derived from a Jev answer. */
export type ContextHealth = "good" | "watch" | "heavy" | "critical";

/** The four independent `noul` judgments, in ask order (AD-2). */
export type CompactionDimensionId =
	| "task_switch"
	| "meaningful_boundary"
	| "history_need"
	| "mid_operation";

export interface CompactionDimension {
	id: CompactionDimensionId;
	value: number; // noul in [0, 1]
	confidence: number; // >= MIN_CONFIDENCE
}

/**
 * Deterministic pressure facts; `facts.ts` is their single owner (AD-3).
 * Any field that cannot be derived is `null`, never a sentinel number.
 */
export interface CompactionFacts {
	reason: string;
	tokensBefore: number | null;
	contextWindow: number | null;
	triggerTokens: number | null;
	headroomTokens: number | null;
	overageTokens: number | null;
	pressure: number | null;
	tier: CompactionTier;
}

/** Compact, redacted semantic state sent to Jev (AD-1). */
export interface CompactionState {
	isSplitTurn: boolean;
	recentEntries: string[];
	priorSummary: string;
	// Volatile pressure fields are serialized but excluded from the signature.
	tokensBefore: number | null;
	overageTokens: number | null;
	pressure: number | null;
}

export interface CompactionOutcome {
	action: CompactionAction;
	source: CompactionSource;
	dimensions: CompactionDimension[];
	reused?: boolean;
	reason?: string;
}

/** Per-session threshold-episode state; in-memory only (AD-5). */
export interface CompactionSessionState {
	consecutiveDefers: number;
	lastSignature: string | null;
	lastOutcome: CompactionOutcome | null;
	jevCalls: number;
	lastCompactionAt: string | null;
	/** One-shot request-tier nudge fired for this threshold episode (AD-8). */
	requestNotified: boolean;
}
