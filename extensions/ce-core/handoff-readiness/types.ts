// Frozen types for semantic handoff-readiness validation (plan Unit 1).
// Namespaced to avoid colliding with stage-gate's StageGateVerdict/Dimension.

/** Operator-resolved readiness mode (R6). Env is the only resolution layer. */
export type ReadinessMode = "off" | "shadow" | "enforce";

/** TypeScript-derived verdict (Goal 2). All three written by `deriveOutcome`. */
export type ReadinessVerdict =
	| "continue"
	| "improve_handoff"
	| "preserve_current_session";

/**
 * Provenance of a verdict:
 * - `jev` — derived from Jev answers.
 * - `deterministic` — derived from a pre-pass short-circuit (no Jev call).
 * - `degraded` — Jev was unavailable or returned an unusable answer set.
 */
export type ReadinessSource = "jev" | "deterministic" | "degraded";

/** The five independent `noul` judgments (no sixth). */
export type ReadinessDimensionId =
	| "continuation_sufficiency"
	| "next_step_clarity"
	| "verification_support"
	| "blocking_open_decisions"
	| "history_need";

export interface ReadinessDimension {
	id: ReadinessDimensionId;
	value: number; // noul in [0, 1]
	confidence: number; // >= MIN_CONFIDENCE, or 1 when forced
	forced: boolean; // true when set by the deterministic pre-pass
}

export interface ReadinessCorrection {
	dimension: ReadinessDimensionId;
	message: string;
}

/** Exact Jev `state` shape (requirements "Exact state shape"). */
export interface ReadinessState {
	currentStage: string;
	nextStage: string;
	handoffMarkdown: string;
	currentTask: string;
	nextMinimalStep: string;
	verification: string;
	blocker: string;
	openDecisions: string[];
	currentTruth: string[];
	invalidatedAssumptions: string[];
	activeFiles: string[];
	recentlyAccessedFiles: string[];
	artifacts: Record<string, string>;
	activeRules: string[];
}

/** One persisted verdict per stage pair (AD-4: no attempts array). */
export interface ReadinessRecord {
	schema: 1;
	pair: string;
	hash: string;
	thresholdsVersion: number;
	verdict: ReadinessVerdict;
	source: ReadinessSource;
	reason?: string;
	dimensions: ReadinessDimension[];
	corrections: ReadinessCorrection[];
	updatedAt: string;
}

export interface ReadinessOutcome {
	verdict: ReadinessVerdict;
	source: ReadinessSource;
	dimensions: ReadinessDimension[];
	corrections: ReadinessCorrection[];
	reason?: string;
}

/** One redacted shadow-log line. */
export interface ReadinessLogRecord {
	ts: string;
	pair: string;
	mode: ReadinessMode;
	source: ReadinessSource;
	verdict: ReadinessVerdict;
	hash: string;
	dimensions: Array<{
		id: ReadinessDimensionId;
		value: number;
		confidence: number;
		forced: boolean;
	}>;
	corrections: string[];
}

export interface ReadinessGuardInput {
	repoRoot: string;
	currentStage: string;
	nextStage: string;
	state: ReadinessState;
}

export interface ReadinessResult extends Partial<ReadinessOutcome> {
	gated: boolean;
	allowed: boolean;
	blocker?: string;
	warning?: string;
}
