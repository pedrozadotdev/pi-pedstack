// Frozen types for turn-level stage drift detection (#8). Namespaced under
// `drift/` so nothing collides with handoff-readiness or stage-gate verdicts.

/** Operator-resolved drift mode. Env is the only resolution layer (AD-6). */
export type DriftMode = "off" | "shadow" | "enforce";

/** TypeScript-derived verdict (never written by Jev). */
export type DriftVerdict = "no_drift" | "mild_drift" | "strong_drift";

/**
 * Provenance of a verdict:
 * - `jev` — derived from a bounded Jev answer set (the only fresh source).
 * - `deterministic` — a pre-pass/dedupe short-circuit (no Jev call).
 * - `degraded` — Jev was unavailable or returned an unusable answer set.
 */
export type DriftSource = "jev" | "deterministic" | "degraded";

/** The four independent `noul` judgments, in ask order (AD-2). */
export type DriftDimensionId =
	| "in_stage_scope"
	| "forbidden_work"
	| "scope_drift"
	| "progress";

export interface DriftDimension {
	id: DriftDimensionId;
	value: number; // noul in [0, 1]
	confidence: number; // >= MIN_CONFIDENCE
}

/**
 * Dimensions that can carry a one-shot correction. `progress` is
 * supporting-only (FT-5) and can never be the triggering signal of a mild
 * verdict, so it is excluded from correction copy.
 */
export type CorrectionDimensionId = Exclude<DriftDimensionId, "progress">;

export interface DriftOutcome {
	verdict: DriftVerdict;
	source: DriftSource;
	dimensions: DriftDimension[];
	triggered: DriftDimensionId[];
	correction?: string;
	reason?: string;
}

/** One tool call observed in the turn (shape-guarded at build time). */
export interface DriftTurnAction {
	tool: string;
	effect: string;
	target: string;
	error: boolean;
	blocked?: boolean;
	reason?: string;
}

/** Compact, redacted turn facts sent to Jev (AD-1). */
export interface DriftTurnState {
	stage: string;
	mandate: string;
	forbidden: string;
	actions: DriftTurnAction[];
	assistantExcerpt: string;
	wroteStageArtifact: boolean;
}

/** Context for the pure verdict derivation (AD-2 table + AD-6 clear rule). */
export interface DeriveContext {
	/** Consecutive mild turns; only from a fresh `source === "jev"` record. */
	priorConsecutiveMild?: number;
	/** Prior verdict; only from a fresh `source === "jev"` record. */
	priorVerdict?: DriftVerdict;
	/** Prior consecutive no-drift turns; only from a fresh `source === "jev"` record. */
	priorConsecutiveNoDrift?: number;
	/** Whether the turn wrote the active stage's own artifact class. */
	wroteStageArtifact?: boolean;
	/**
	 * Recurrence knob (D4): a mild signal escalates to strong once the prior
	 * consecutive-mild count reaches `limit - 1`. Invalid values clamp to 2.
	 */
	mildRepeatLimit?: number;
}

/** Result of the pure derivation; counters are ready to persist. */
export interface DerivedVerdict {
	verdict: DriftVerdict;
	triggered: DriftDimensionId[];
	consecutiveMild: number;
	consecutiveNoDrift: number;
}
