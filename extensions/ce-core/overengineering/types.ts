// Frozen contract for the Ponytail/YAGNI overengineering signal (plan Unit 1).
// Pure types + constants; every other overengineering module imports from here.
//
// The four dimensions ride the existing stage-gate Jev request. They are
// floor-only (excluded from `weightedAverage`) and remain inert until
// features.overengineering.mode is "enforce" (see `OVERENGINEERING_FLOOR`).

/** The four dimensions, in frozen scoring order. */
export const OVERENGINEERING_DIMENSION_IDS = [
	"no_unrequested_abstraction",
	"scope_fidelity",
	"complexity_proportionality",
	"dependency_justification",
] as const;

export type OverengineeringDimensionId =
	(typeof OVERENGINEERING_DIMENSION_IDS)[number];

/**
 * Why a dimension could not be scored. A skipped dimension is always absent
 * from `sem`; a sentinel score is never written (plan "Partial-failure handling").
 */
export const OVERENGINEERING_SKIP_REASONS = [
	"no_baseline",
	"baseline_too_weak",
	"package_json_unreadable",
	"git_unavailable",
	"request_too_large",
] as const;

export type OverengineeringSkipReason =
	(typeof OVERENGINEERING_SKIP_REASONS)[number];

export interface OverengineeringSkip {
	dimension: OverengineeringDimensionId;
	reason: OverengineeringSkipReason;
}

/** One normative excerpt (≤ 2 KiB UTF-8, head-only) plus its source paths. */
export interface BaselineRef {
	text: string;
	paths: string[];
	truncated: boolean;
}

/** Structured per-stage baseline; `04-review` supplies both. */
export interface OverengineeringBaselines {
	requirements?: BaselineRef;
	plan?: BaselineRef;
}

/** Protected complexity is context only — never an automatic pass. */
export type ProtectedComplexityTag =
	| "validation"
	| "security"
	| "observability"
	| "migration"
	| "error_handling"
	| "tests";

/** Deterministic facts extracted from the diff, untracked files, and manifests. */
export interface OverengineeringFacts {
	newDependencies: string[];
	addedFiles: string[];
	addedImportsExports: string[];
	diffBytes: number;
	diffExcerptBytes: number;
	/** Head+tail, secret-redacted diff excerpt injected into the Jev request. */
	diffExcerpt: string;
	protectedComplexity: ProtectedComplexityTag[];
	skippedDimensions: OverengineeringSkip[];
	truncated: {
		addedFiles: number;
		newDependencies: number;
		addedImportsExports: number;
		untrackedSkipped: number;
	};
	baselineProvenance?: string;
}

/** The composed signal handed to the gate engine. */
export interface OverengineeringSignal {
	status: "ready" | "unavailable";
	baselines: OverengineeringBaselines;
	baselinePaths: string[];
	baselineHash: string;
	facts: OverengineeringFacts;
	skippedDimensions: OverengineeringSkip[];
	reason?: "no_baseline" | "request_too_large";
}

/** Operator-resolved overengineering mode (env only; default `shadow`). */
export type OverengineeringMode = "off" | "shadow" | "enforce";

/**
 * `jev` — the four dims were asked; `unavailable` — no baseline or all skipped.
 */
export type OverengineeringSource = "jev" | "unavailable";

/** The `overengineering` field persisted on a schema-2 attempt. */
export interface OverengineeringRecord {
	facts: OverengineeringFacts;
	baselinePaths: string[];
	baselineHash: string;
	skippedDimensions: OverengineeringSkip[];
	source: OverengineeringSource;
}

/** One redacted shadow-log line (D10 calibration input). */
export interface OverengineeringLogRecord {
	ts: string;
	stage: string;
	mode: OverengineeringMode;
	source: OverengineeringSource;
	baselinePaths: string[];
	baselineHash: string;
	dimensions: Array<{
		id: OverengineeringDimensionId;
		normalized: number;
		score?: number;
	}>;
	skippedDimensions: OverengineeringSkip[];
	verdict: string;
}
