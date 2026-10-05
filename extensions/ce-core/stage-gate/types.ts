// Frozen types for the stage gate (plan Unit 1). Pure data + signatures only,
// so every predicate in `rubrics.ts` can be a pure function over `Evidence`.

/** The 7 pedstack pipeline stages (R8). */
export type StageKey =
	| "01-brainstorm"
	| "02-plan"
	| "03-work"
	| "04-review"
	| "04-5-debug"
	| "05-learn"
	| "06-docsync";

/** One already-resolved, already-read artifact file. */
export interface EvidenceFile {
	path: string;
	text: string;
	bytes: number;
}

export interface ReviewFinding {
	severity?: string;
	evidence?: string;
	[key: string]: unknown;
}

export interface ReviewFindingsFile {
	path: string;
	findings: ReviewFinding[];
	count?: number;
}

export interface CheckpointRecord {
	path: string;
	status?: string;
	completedUnits?: unknown[];
	[key: string]: unknown;
}

/**
 * Everything a deterministic predicate may read. Built once by `evidence.ts`
 * (Unit 2) and consumed read-only here, which keeps the predicates pure.
 */
export interface Evidence {
	stage: StageKey;
	repoRoot: string;
	artifacts: string[];
	files: EvidenceFile[];
	txt: string;
	errors: string[];
	warnings: string[];
	reviewFindings: ReviewFindingsFile[];
	checkpoints: CheckpointRecord[];
	contextState: Record<string, unknown> | null;
	planText: string | null;
	gitDiff: string | null;
	truncated: boolean;
}

export interface DeterministicCheckResult {
	pass: boolean;
	reason: string;
}

/** One atomic, independently judged requirement (R12/G2). */
export interface DeterministicCheck {
	readonly id: string;
	readonly critical: boolean;
	readonly evaluate: (evidence: Evidence) => DeterministicCheckResult;
}

export interface SemanticDimension {
	readonly id: string;
	readonly weight: number;
	readonly description: string;
}

export interface StageRubric {
	readonly stage: StageKey;
	readonly artifactGlobs: readonly string[];
	readonly artifactDir: string;
	readonly findingsGlob?: string;
	readonly checks: readonly DeterministicCheck[];
	readonly semanticDimensions: readonly SemanticDimension[];
}

export interface DeterministicResult {
	id: string;
	critical: boolean;
	pass: boolean;
	reason: string;
}

/** One raw semantic score as returned by Jev, before normalization. */
export interface SemanticScoreInput {
	id: string;
	score: number;
	levels: number;
	confidence?: number;
	weight?: number;
}

/** One normalized semantic score, as persisted in the gate record. */
export interface SemanticScore {
	id: string;
	score: number;
	normalized: number;
	confidence: number;
	weight: number;
}

/** One combined gate verdict (R5). */
export type StageGateVerdict = "accept" | "revise" | "review" | "escalate";

/** Operator-resolved gate mode (R11). Env is the only resolution layer. */
export type StageGateMode = "off" | "shadow" | "enforce";

export interface GateUsage {
	input_tokens: number;
	output_tokens: number;
}

/** One persisted evaluation (record schema in the plan). */
export interface StageGateAttempt {
	schema: 1;
	stage: StageKey;
	verdict: StageGateVerdict;
	enforcing: boolean;
	weightedScore: number | null;
	det: DeterministicResult[];
	sem: SemanticScore[];
	criticalFailed: boolean;
	jevUnavailable: boolean;
	jevReason: string | null;
	model: string;
	usage?: GateUsage;
	warnings: string[];
	artifacts: string[];
	artifactsHash: string;
	attempt: number;
	updatedAt: string;
}

/** File-level container at `.context/compound-engineering/stage-gates/<stage>.json`. */
export interface StageGateRecord {
	stage: StageKey;
	attempts: StageGateAttempt[];
}
