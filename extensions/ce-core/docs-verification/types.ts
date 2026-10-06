// Frozen types for runtime source-driven documentation verification (plan Unit 1).
// Pure data + signatures only; every predicate in `combine.ts` is pure over these.

/** Operator-resolved mode. Env is the only resolution layer (R9). */
export type DocsVerificationMode = "off" | "shadow" | "enforce";

/** Facts are planned at `02-plan`, observed at `03-work` (R2/R3). */
export type DocsPhase = "planned" | "observed";

/** TypeScript-derived decision; never authored by Jev (R4). */
export type DocsDecision = "not_required" | "required" | "uncertain";

/** Obligation lifecycle (R5). */
export type ObligationStatus = "open" | "satisfied" | "waived";

/** Provenance of a unit record (R8). */
export type DocsEvidenceSource = "jev" | "deterministic" | "degraded" | "fallback";

/** The three atomic `noul` judgments (R3). */
export type DocsQuestionId =
	| "external_api_dependence"
	| "version_sensitivity"
	| "verification_material";

export interface DeclaredFile {
	path: string;
	exists: boolean;
}

export type LockKind = "bun" | "npm" | "pnpm" | "yarn";

export interface PackageFact {
	name: string;
	version: string | null;
	versionUnknown: boolean;
	kind: "dependency" | "peer" | "dev" | "dynamic" | "ambiguous";
}

export interface FactsInput {
	phase: DocsPhase;
	unitText: string;
	declaredFiles: string[];
	nearestManifestPath: string | null;
	workspaceRoot: string | null;
}

export interface FactsDeps {
	readFile: (absPath: string) => Promise<string>;
	exists: (absPath: string) => boolean;
}

export interface EvidenceFact {
	package: string;
	version: string;
	docRef: string;
	valid: boolean;
	reason?: string;
}

export interface UnitFacts {
	phase: DocsPhase;
	declaredFiles: DeclaredFile[];
	packages: PackageFact[];
	evidence: EvidenceFact[];
	versionUnknown: boolean;
}

export interface DocsUnit {
	slug: string;
	heading: string;
	hash: string;
	files: string[];
	text: string;
}

export interface DocsObligation {
	slug: string;
	status: ObligationStatus;
	decision: DocsDecision;
	packages: string[];
	source: DocsEvidenceSource;
	reason?: string;
	evidence?: EvidenceFact;
	updatedAt: string;
}

export interface DocsUnitRecord {
	slug: string;
	hash: string;
	phase: DocsPhase;
	facts: UnitFacts;
	decision: DocsDecision;
	packages: string[];
	obligation?: DocsObligation;
	source: DocsEvidenceSource;
	reason?: string;
}

export interface DocsVerificationRecord {
	schema: 1;
	planPath: string;
	grammar: 1;
	activePhase: DocsPhase;
	thresholdsVersion: number;
	units: DocsUnitRecord[];
	droppedUnits: { slug: string; reason: string }[];
	updatedAt: string;
}

export interface DocsVerificationResult {
	gated: boolean;
	allowed: boolean;
	blocker?: string;
	warning?: string;
	decision: DocsDecision;
	obligations: DocsObligation[];
	source: DocsEvidenceSource;
	reused: boolean;
}

export interface EvidenceObligations {
	applicable: boolean;
	planHasExternalPackages: boolean;
	storePresent: boolean;
	stale: boolean;
	degraded: boolean;
	failClosed: boolean;
	open: number;
	satisfied: number;
	waived: number;
}

/** Raw `noul` answers keyed by question id, as read back from a Jev result. */
export interface DocsAnswers {
	external_api_dependence: number;
	version_sensitivity: number;
	verification_material: number;
}
