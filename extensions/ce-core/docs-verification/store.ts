// Docs verification record store (plan Unit 4). Persistence, the single
// freshness predicate, carry-over, and mode resolution. Corrupt-safe readers.
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSlug } from "../utils/name-utils";
import { THRESHOLDS_VERSION } from "./combine";
import type {
	DeclaredFile,
	DocsDecision,
	DocsEvidenceSource,
	DocsObligation,
	DocsPhase,
	DocsUnitRecord,
	DocsVerificationMode,
	DocsVerificationRecord,
	EvidenceFact,
	ObligationStatus,
	PackageFact,
	UnitFacts,
} from "./types";

export const DOCS_VERIFICATION_DIR = ".context/compound-engineering/docs-verification";
export const DOCS_LOG_FILE = ".context/compound-engineering/docs-verification.jsonl";
export const DOCS_LOG_ROTATED_FILE =
	".context/compound-engineering/docs-verification.1.jsonl";
export const MAX_DOCS_LOG_BYTES = 1_048_576;

const PHASES = new Set<DocsPhase>(["planned", "observed"]);
const DECISIONS = new Set<DocsDecision>(["not_required", "required", "uncertain"]);
const STATUSES = new Set<ObligationStatus>(["open", "satisfied", "waived"]);
const SOURCES = new Set<DocsEvidenceSource>([
	"jev",
	"deterministic",
	"degraded",
	"fallback",
]);
const PACKAGE_KINDS = new Set<PackageFact["kind"]>([
	"dependency",
	"peer",
	"dev",
	"dynamic",
	"ambiguous",
]);

/** `PEDSTACK_DOCS_VERIFICATION`: missing/empty/invalid resolves to `shadow`. */
export function resolveDocsVerificationMode(
	env: Record<string, string | undefined>,
): DocsVerificationMode {
	const value = env.PEDSTACK_DOCS_VERIFICATION;
	if (value === "off") return "off";
	if (value === "enforce") return "enforce";
	return "shadow";
}

export function resolveDocsVerificationFailClosed(
	env: Record<string, string | undefined>,
): boolean {
	return env.PEDSTACK_DOCS_VERIFICATION_FAILCLOSED === "1";
}

/** Slugified plan basename; a traversal attempt cannot escape the repo root. */
export function planSlugFromPath(planPath: string): string {
	const base = path.basename(planPath.replace(/\\/g, "/")).replace(/\.md$/i, "");
	return normalizeSlug(base) || "plan";
}

export function docsRecordPath(repoRoot: string, planSlug: string): string {
	return path.join(repoRoot, DOCS_VERIFICATION_DIR, `${planSlug}.json`);
}

/** Newest `docs/plans/*.md` by mtime, ties broken by path (plan identity, R7). */
export async function newestPlanPath(repoRoot: string): Promise<string | null> {
	const dir = path.join(repoRoot, "docs/plans");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	const files: Array<{ rel: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		try {
			const info = await stat(path.join(dir, name));
			files.push({ rel: `docs/plans/${name}`, mtimeMs: info.mtimeMs });
		} catch {
			// unreadable entry: skip
		}
	}
	if (files.length === 0) return null;
	files.sort((a, b) =>
		b.mtimeMs - a.mtimeMs !== 0 ? b.mtimeMs - a.mtimeMs : a.rel.localeCompare(b.rel),
	);
	return files[0].rel;
}

/** Resolve the active plan path and text; null when none is readable. */
export async function resolveActivePlan(
	repoRoot: string,
): Promise<{ path: string; text: string } | null> {
	const planPath = await newestPlanPath(repoRoot);
	if (!planPath) return null;
	try {
		const text = await readFile(path.join(repoRoot, planPath), "utf8");
		return { path: planPath, text };
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDeclaredFile(value: unknown): value is DeclaredFile {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.exists === "boolean"
	);
}

function isPackageFact(value: unknown): value is PackageFact {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		(value.version === null || typeof value.version === "string") &&
		typeof value.versionUnknown === "boolean" &&
		typeof value.kind === "string" &&
		PACKAGE_KINDS.has(value.kind as PackageFact["kind"])
	);
}

function isEvidenceFact(value: unknown): value is EvidenceFact {
	return (
		isRecord(value) &&
		typeof value.package === "string" &&
		typeof value.version === "string" &&
		typeof value.docRef === "string" &&
		typeof value.valid === "boolean" &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function isFacts(value: unknown): value is UnitFacts {
	return (
		isRecord(value) &&
		typeof value.phase === "string" &&
		PHASES.has(value.phase as DocsPhase) &&
		Array.isArray(value.declaredFiles) &&
		value.declaredFiles.every(isDeclaredFile) &&
		Array.isArray(value.packages) &&
		value.packages.every(isPackageFact) &&
		Array.isArray(value.evidence) &&
		value.evidence.every(isEvidenceFact) &&
		typeof value.versionUnknown === "boolean"
	);
}

function isObligation(value: unknown): value is DocsObligation {
	return (
		isRecord(value) &&
		typeof value.slug === "string" &&
		typeof value.status === "string" &&
		STATUSES.has(value.status as ObligationStatus) &&
		typeof value.decision === "string" &&
		DECISIONS.has(value.decision as DocsDecision) &&
		Array.isArray(value.packages) &&
		value.packages.every((entry) => typeof entry === "string") &&
		typeof value.source === "string" &&
		SOURCES.has(value.source as DocsEvidenceSource) &&
		(value.reason === undefined || typeof value.reason === "string") &&
		(value.evidence === undefined || isEvidenceFact(value.evidence)) &&
		typeof value.updatedAt === "string"
	);
}

function isUnitRecord(value: unknown): value is DocsUnitRecord {
	return (
		isRecord(value) &&
		typeof value.slug === "string" &&
		typeof value.hash === "string" &&
		typeof value.phase === "string" &&
		PHASES.has(value.phase as DocsPhase) &&
		isFacts(value.facts) &&
		typeof value.decision === "string" &&
		DECISIONS.has(value.decision as DocsDecision) &&
		Array.isArray(value.packages) &&
		value.packages.every((entry) => typeof entry === "string") &&
		(value.obligation === undefined || isObligation(value.obligation)) &&
		typeof value.source === "string" &&
		SOURCES.has(value.source as DocsEvidenceSource) &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

/** Element-by-element validation; any mismatch is a corrupt record (null). */
function validateRecord(parsed: unknown): DocsVerificationRecord | null {
	if (!isRecord(parsed)) return null;
	if (parsed.schema !== 1 || parsed.grammar !== 1) return null;
	if (typeof parsed.planPath !== "string" || parsed.planPath.length === 0) {
		return null;
	}
	if (typeof parsed.activePhase !== "string" || !PHASES.has(parsed.activePhase as DocsPhase)) {
		return null;
	}
	if (typeof parsed.thresholdsVersion !== "number") return null;
	if (!Array.isArray(parsed.units) || !parsed.units.every(isUnitRecord)) return null;
	if (
		!Array.isArray(parsed.droppedUnits) ||
		!parsed.droppedUnits.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.slug === "string" &&
				typeof entry.reason === "string",
		)
	) {
		return null;
	}
	if (typeof parsed.updatedAt !== "string") return null;
	// SAFETY: every field above was checked element-by-element; the shape now
	// matches DocsVerificationRecord and no unchecked field is exposed.
	return parsed as unknown as DocsVerificationRecord;
}

export async function readDocsRecord(
	repoRoot: string,
	planSlug: string,
): Promise<DocsVerificationRecord | null> {
	try {
		const content = await readFile(docsRecordPath(repoRoot, planSlug), "utf8");
		return validateRecord(JSON.parse(content));
	} catch {
		return null;
	}
}

export async function writeDocsRecord(
	repoRoot: string,
	record: DocsVerificationRecord,
): Promise<string> {
	const filePath = docsRecordPath(repoRoot, planSlugFromPath(record.planPath));
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
	return filePath;
}

/**
 * Fresh iff schema, plan path, active phase, thresholds version, the matching
 * unit's hash, and a non-degraded provenance all match. A degraded unit is never
 * reused, so an outage can never disable later recomputation (R7).
 */
export function isUnitFresh(
	record: DocsVerificationRecord | null,
	expected: {
		planPath: string;
		activePhase: DocsPhase;
		slug: string;
		hash: string;
	},
): boolean {
	if (!record) return false;
	if (record.schema !== 1) return false;
	if (record.planPath !== expected.planPath) return false;
	if (record.activePhase !== expected.activePhase) return false;
	if (record.thresholdsVersion !== THRESHOLDS_VERSION) return false;
	const unit = record.units.find((entry) => entry.slug === expected.slug);
	if (!unit) return false;
	if (unit.phase !== expected.activePhase) return false;
	if (unit.hash !== expected.hash) return false;
	return unit.source !== "degraded";
}

/** Composes `isUnitFresh` over every unit in the record (the single predicate). */
export function isRecordFresh(
	record: DocsVerificationRecord | null,
	expected: {
		planPath: string;
		activePhase: DocsPhase;
		unitHashes: Map<string, string>;
	},
): boolean {
	if (!record || record.units.length === 0) return false;
	for (const unit of record.units) {
		const hash = expected.unitHashes.get(unit.slug);
		if (hash === undefined) return false;
		if (
			!isUnitFresh(record, {
				planPath: expected.planPath,
				activePhase: expected.activePhase,
				slug: unit.slug,
				hash,
			})
		) {
			return false;
		}
	}
	return true;
}

function reopen(
	prior: DocsObligation,
	unit: DocsUnitRecord,
): DocsObligation | undefined {
	if (unit.decision === "not_required") return undefined;
	return { ...prior, status: "open", decision: unit.decision };
}

function carriedObligation(
	prior: DocsUnitRecord,
	unit: DocsUnitRecord,
): DocsObligation | undefined {
	// Never downgrade a freshly derived open obligation (a re-score wins).
	if (unit.obligation?.status === "open") return unit.obligation;
	// A unit that no longer requires verification carries no obligation.
	if (unit.decision === "not_required" && !unit.obligation) return undefined;
	const obligation = prior.obligation as DocsObligation;
	if (obligation.status === "satisfied") {
		// A satisfied carry needs current evidence: never override a freshly
		// re-scored unit whose evidence line is gone (only packages would match).
		if (unit.facts.evidence.length === 0) return undefined;
		const stillPresent =
			obligation.packages.length > 0 &&
			obligation.packages.every((entry) => unit.packages.includes(entry));
		return stillPresent ? obligation : undefined;
	}
	if (obligation.status === "waived") {
		return prior.hash === unit.hash ? obligation : reopen(obligation, unit);
	}
	return prior.hash === unit.hash ? obligation : undefined;
}

function dropObligation(unit: DocsUnitRecord): DocsUnitRecord {
	const { obligation: _dropped, ...rest } = unit;
	return rest as DocsUnitRecord;
}

/**
 * Carry open/waived/satisfied obligations across a plan rewrite by unit slug.
 * Only vanished units are dropped, recorded in `droppedUnits` with a reason (R7).
 */
export function carryOverObligations(
	previous: DocsVerificationRecord | null,
	next: DocsVerificationRecord,
): DocsVerificationRecord {
	if (!previous) return next;
	const priorBySlug = new Map(previous.units.map((unit) => [unit.slug, unit]));
	const nextSlugs = new Set(next.units.map((unit) => unit.slug));
	const units = next.units.map((unit) => {
		const prior = priorBySlug.get(unit.slug);
		if (!prior?.obligation) return unit;
		const carried = carriedObligation(prior, unit);
		return carried ? { ...unit, obligation: carried } : dropObligation(unit);
	});
	return {
		...next,
		units,
		droppedUnits: previous.units
			.filter((unit) => !nextSlugs.has(unit.slug))
			.map((unit) => ({
				slug: unit.slug,
				reason: "unit no longer present in the plan",
			})),
	};
}

// ponytail: one serialized chain; the guard writes at most one log per save.
let chain: Promise<void> = Promise.resolve();

async function writeLog(
	repoRoot: string,
	record: DocsVerificationRecord,
): Promise<void> {
	const file = path.join(repoRoot, DOCS_LOG_FILE);
	const rotated = path.join(repoRoot, DOCS_LOG_ROTATED_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		size = 0;
	}
	if (size >= MAX_DOCS_LOG_BYTES) await rename(file, rotated);
	const line = {
		ts: record.updatedAt,
		planPath: record.planPath,
		activePhase: record.activePhase,
		units: record.units.map((unit) => ({
			slug: unit.slug,
			decision: unit.decision,
			status: unit.obligation?.status ?? null,
			source: unit.source,
		})),
	};
	await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

/** Append one redacted shadow record, rotating once at the byte cap. Never rejects. */
export function appendDocsLog(
	repoRoot: string,
	record: DocsVerificationRecord,
): Promise<void> {
	const next = chain.then(async () => {
		try {
			await writeLog(repoRoot, record);
		} catch {
			// ponytail: swallowed by design — the sink is best-effort telemetry.
		}
	});
	chain = next;
	return next;
}
