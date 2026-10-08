// Docs verification guard (plan Unit 5). Owns precedence only: mode check,
// deterministic facts, freshness reuse, one bounded Jev decide(), obligation
// construction and persistence. Every I/O is injected.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JevRuntime } from "../jev/types";
import {
	DOCS_JEV_TIMEOUT_MS,
	EVIDENCE_GRAMMAR,
	MAX_UNITS,
	buildDocsRequest,
	buildObligation,
	deriveDecision,
	enforceRequestBodyLimit,
	packageNames,
	readDocsAnswers,
	shortCircuitDecision,
} from "./combine";
import { buildUnitPlanFacts, nearestManifest, observedFileHashes } from "./facts";
import {
	appendDocsLog,
	isUnitFresh,
	planSlugFromPath,
	readDocsRecord,
	writeDocsRecord,
} from "./store";
import { extractUnits, unitContentHash } from "./units";
import type {
	DocsDecision,
	DocsEvidenceSource,
	DocsObligation,
	DocsPhase,
	DocsUnit,
	DocsUnitRecord,
	DocsVerificationMode,
	DocsVerificationRecord,
	DocsVerificationResult,
	FactsDeps,
	FactsInput,
	UnitFacts,
} from "./types";

export interface DocsVerificationGuardInput {
	repoRoot: string;
	/** Repo-relative active plan path. */
	planPath: string;
	phase: DocsPhase;
	planText: string;
}

export interface DocsVerificationWaiveInput {
	repoRoot: string;
	planPath: string;
	slug: string;
	reason: string;
}

export interface DocsVerificationGuardDeps {
	mode: DocsVerificationMode;
	failClosed: boolean;
	createJev: () => JevRuntime;
	now?: () => Date;
	/** Test seam: replaces the real deterministic fact builder. */
	facts?: (input: FactsInput) => Promise<UnitFacts>;
	readFile?: (absPath: string) => Promise<string>;
	fileExists?: (repoRoot: string, relPath: string) => boolean;
	readRecord?: (
		repoRoot: string,
		planSlug: string,
	) => Promise<DocsVerificationRecord | null>;
	writeRecord?: (
		repoRoot: string,
		record: DocsVerificationRecord,
	) => Promise<string> | string;
	logRecord?: (
		repoRoot: string,
		record: DocsVerificationRecord,
	) => Promise<void> | void;
}

export interface DocsVerificationGuard {
	evaluate(input: DocsVerificationGuardInput): Promise<DocsVerificationResult>;
	waive(input: DocsVerificationWaiveInput): Promise<DocsVerificationResult>;
}

interface UnitPlan {
	unit: DocsUnit;
	facts: UnitFacts;
	hash: string;
}

const OFF_RESULT: DocsVerificationResult = {
	gated: false,
	allowed: true,
	decision: "not_required",
	obligations: [],
	source: "deterministic",
	reused: false,
};

function absoluteProbe(
	repoRoot: string,
	deps: DocsVerificationGuardDeps,
): (absPath: string) => boolean {
	if (deps.fileExists) {
		const injected = deps.fileExists;
		return (absPath) => {
			try {
				return injected(repoRoot, path.relative(repoRoot, absPath));
			} catch {
				return true;
			}
		};
	}
	return (absPath) => existsSync(absPath);
}

function readFileFn(
	deps: DocsVerificationGuardDeps,
): (absPath: string) => Promise<string> {
	return deps.readFile ?? ((absPath) => readFile(absPath, "utf8"));
}

function emptyFacts(phase: DocsPhase): UnitFacts {
	return {
		phase,
		declaredFiles: [],
		packages: [],
		evidence: [],
		versionUnknown: false,
	};
}

function recordFrom(
	plan: UnitPlan,
	decision: DocsDecision,
	source: DocsEvidenceSource,
	now: () => Date,
	options: { reason?: string } = {},
): DocsUnitRecord {
	const base: Omit<DocsUnitRecord, "obligation"> = {
		slug: plan.unit.slug,
		hash: plan.hash,
		phase: plan.facts.phase,
		facts: plan.facts,
		decision,
		packages: packageNames(plan.facts),
		source,
		...(options.reason ? { reason: options.reason } : {}),
	};
	if (decision === "not_required") return base;
	return { ...base, obligation: buildObligation(base, now) };
}

function satisfiedRecord(
	plan: UnitPlan,
	source: DocsEvidenceSource,
	updatedAt: string,
): DocsUnitRecord {
	const base: Omit<DocsUnitRecord, "obligation"> = {
		slug: plan.unit.slug,
		hash: plan.hash,
		phase: plan.facts.phase,
		facts: plan.facts,
		decision: "not_required",
		packages: packageNames(plan.facts),
		source,
	};
	const evidence = plan.facts.evidence[0];
	return {
		...base,
		obligation: {
			slug: plan.unit.slug,
			status: "satisfied",
			decision: "not_required",
			packages: base.packages,
			source,
			...(evidence ? { evidence } : {}),
			updatedAt,
		},
	};
}

function truncatedRecord(
	unit: DocsUnit,
	phase: DocsPhase,
	now: () => Date,
): DocsUnitRecord {
	return recordFrom(
		{ unit, facts: emptyFacts(phase), hash: unit.hash },
		"uncertain",
		"deterministic",
		now,
		{ reason: `plan exceeds the ${MAX_UNITS}-unit cap` },
	);
}

function aggregateDecision(units: DocsUnitRecord[]): DocsDecision {
	const open = units.filter((unit) => unit.obligation?.status === "open");
	if (open.some((unit) => unit.decision === "required")) return "required";
	return open.length > 0 ? "uncertain" : "not_required";
}

function toResult(
	record: DocsVerificationRecord,
	mode: DocsVerificationMode,
	failClosed: boolean,
	reused: boolean,
): DocsVerificationResult {
	const obligations = record.units
		.map((unit) => unit.obligation)
		.filter((entry): entry is DocsObligation => Boolean(entry));
	const open = obligations.filter((entry) => entry.status === "open");
	const degraded = record.units.some((unit) => unit.source === "degraded");
	const source: DocsEvidenceSource = degraded
		? "degraded"
		: record.units.some((unit) => unit.source === "jev")
			? "jev"
			: "deterministic";
	const base: DocsVerificationResult = {
		gated: true,
		allowed: true,
		decision: aggregateDecision(record.units),
		obligations,
		source,
		reused,
	};
	const slugs = open.map((entry) => entry.slug).join(", ");
	if (mode === "enforce" && open.length > 0 && !(degraded && !failClosed)) {
		return {
			...base,
			allowed: false,
			blocker:
				`Cannot complete this stage: ${open.length} docs-verification ` +
				`obligation(s) are open (${slugs}). Check official documentation ` +
				`and record a docs-verified: line, or waive with a reason.`,
		};
	}
	const warnings: string[] = [];
	if (open.length > 0) {
		warnings.push(
			`docs verification: ${open.length} open obligation(s) (${slugs}).`,
		);
	}
	if (degraded) {
		warnings.push(
			"docs verification degraded: the semantic layer was unavailable; obligations stay open.",
		);
	}
	return { ...base, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
}

async function persist(
	repoRoot: string,
	record: DocsVerificationRecord,
	deps: DocsVerificationGuardDeps,
): Promise<void> {
	try {
		if (deps.writeRecord) await deps.writeRecord(repoRoot, record);
		else await writeDocsRecord(repoRoot, record);
	} catch {
		// ponytail: swallowed — the verdict is already decided.
	}
	try {
		if (deps.logRecord) await deps.logRecord(repoRoot, record);
		else await appendDocsLog(repoRoot, record);
	} catch {
		// ponytail: swallowed — the sink is best-effort telemetry.
	}
}

async function buildUnitPlan(
	unit: DocsUnit,
	input: DocsVerificationGuardInput,
	deps: DocsVerificationGuardDeps,
): Promise<UnitPlan> {
	const factsDeps: FactsDeps = {
		readFile: readFileFn(deps),
		exists: absoluteProbe(input.repoRoot, deps),
	};
	if (deps.facts) {
		const facts = await deps.facts({
			phase: input.phase,
			unitText: unit.text,
			declaredFiles: unit.files,
			nearestManifestPath: nearestManifest(
				input.repoRoot,
				unit.files,
				factsDeps.exists,
			),
			workspaceRoot: input.repoRoot,
		});
		const hashes = await observedFileHashes(
			input.repoRoot,
			facts,
			factsDeps.readFile,
		);
		return { unit, facts, hash: unitContentHash(unit, facts, hashes) };
	}
	const { facts, hash } = await buildUnitPlanFacts(
		unit,
		{ repoRoot: input.repoRoot, phase: input.phase },
		factsDeps,
	);
	return { unit, facts, hash };
}

interface ClassifiedPlans {
	records: Map<string, DocsUnitRecord>;
	toScore: UnitPlan[];
}

/** Deterministic short-circuit -> evidence -> freshness reuse, in that order. */
function classifyPlans(
	plans: UnitPlan[],
	previous: DocsVerificationRecord | null,
	input: DocsVerificationGuardInput,
	now: () => Date,
): ClassifiedPlans {
	const records = new Map<string, DocsUnitRecord>();
	const toScore: UnitPlan[] = [];
	for (const plan of plans) {
		const prior = previous?.units.find((entry) => entry.slug === plan.unit.slug);
		const fallbackSatisfied =
			prior?.obligation?.status === "satisfied" &&
			prior.obligation.source === "fallback";
		const shortCircuit = shortCircuitDecision(plan.facts);
		if (shortCircuit !== null && !fallbackSatisfied) {
			records.set(
				plan.unit.slug,
				recordFrom(plan, shortCircuit, "deterministic", now),
			);
			continue;
		}
		if (
			shortCircuit === null &&
			plan.facts.evidence.length > 0 &&
			!fallbackSatisfied
		) {
			records.set(
				plan.unit.slug,
				satisfiedRecord(plan, "deterministic", now().toISOString()),
			);
			continue;
		}
		if (
			prior &&
			!fallbackSatisfied &&
			isUnitFresh(previous, {
				planPath: input.planPath,
				activePhase: input.phase,
				slug: plan.unit.slug,
				hash: plan.hash,
			})
		) {
			records.set(plan.unit.slug, prior);
			continue;
		}
		toScore.push(plan);
	}
	return { records, toScore };
}

interface ScoreOutcome {
	degraded: boolean;
	reason: string;
}

/** One bounded `decide()` for all scorable units; a failure degrades them all. */
async function scorePlans(
	toScore: UnitPlan[],
	deps: DocsVerificationGuardDeps,
	records: Map<string, DocsUnitRecord>,
	now: () => Date,
): Promise<ScoreOutcome> {
	if (toScore.length === 0) return { degraded: false, reason: "" };
	try {
		const request = buildDocsRequest(
			toScore.map((plan) => plan.unit),
			new Map(toScore.map((plan) => [plan.unit, plan.facts])),
		);
		enforceRequestBodyLimit(request);
		const result = await deps.createJev().decide(request, {
			timeoutMs: DOCS_JEV_TIMEOUT_MS,
		});
		let degraded = false;
		let reason = "";
		for (const plan of toScore) {
			const answers = readDocsAnswers(result, plan.unit.slug);
			if (typeof answers === "string") {
				degraded = true;
				reason = answers;
				records.set(
					plan.unit.slug,
					recordFrom(plan, "uncertain", "degraded", now, { reason: answers }),
				);
				continue;
			}
			const decision = deriveDecision(answers, plan.facts);
			records.set(
				plan.unit.slug,
				decision === "not_required" && plan.facts.evidence.length > 0
					? satisfiedRecord(plan, "jev", now().toISOString())
					: recordFrom(plan, decision, "jev", now),
			);
		}
		return { degraded, reason };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		for (const plan of toScore) {
			records.set(
				plan.unit.slug,
				recordFrom(plan, "uncertain", "degraded", now, { reason }),
			);
		}
		return { degraded: true, reason };
	}
}

/** Evidence-satisfied units become provisional fallback when the run degraded. */
function applyFallback(records: Map<string, DocsUnitRecord>): void {
	for (const [slug, record] of records) {
		if (record.source === "deterministic" && record.obligation?.status === "satisfied") {
			records.set(slug, {
				...record,
				source: "fallback",
				obligation: { ...record.obligation, source: "fallback" },
			});
		}
	}
}

async function evaluate(
	input: DocsVerificationGuardInput,
	deps: DocsVerificationGuardDeps,
): Promise<DocsVerificationResult> {
	if (deps.mode === "off") return { ...OFF_RESULT };
	const now = deps.now ?? (() => new Date());
	const units = extractUnits(input.planText, input.phase);
	if (units.length === 0) return { ...OFF_RESULT, gated: true };

	const previous = await (deps.readRecord ?? readDocsRecord)(
		input.repoRoot,
		planSlugFromPath(input.planPath),
	);
	const scorable = units.slice(0, MAX_UNITS);
	const plans: UnitPlan[] = [];
	for (const unit of scorable) {
		plans.push(await buildUnitPlan(unit, input, deps));
	}
	const { records, toScore } = classifyPlans(plans, previous, input, now);
	const outcome = await scorePlans(toScore, deps, records, now);
	if (outcome.degraded) applyFallback(records);
	for (const unit of units.slice(MAX_UNITS)) {
		records.set(unit.slug, truncatedRecord(unit, input.phase, now));
	}

	const orderedUnits = [...scorable, ...units.slice(MAX_UNITS)].map(
		(unit) => records.get(unit.slug) as DocsUnitRecord,
	);
	const droppedUnits = (previous?.units ?? [])
		.filter((entry) => !orderedUnits.some((unit) => unit.slug === entry.slug))
		.map((entry) => ({
			slug: entry.slug,
			reason: "unit no longer present in the plan",
		}));
	const record: DocsVerificationRecord = {
		schema: 1,
		planPath: input.planPath,
		grammar: EVIDENCE_GRAMMAR,
		activePhase: input.phase,
		thresholdsVersion: 1,
		units: orderedUnits,
		droppedUnits,
		updatedAt: now().toISOString(),
	};
	await persist(input.repoRoot, record, deps);
	return toResult(record, deps.mode, deps.failClosed, toScore.length === 0);
}

async function waive(
	input: DocsVerificationWaiveInput,
	deps: DocsVerificationGuardDeps,
): Promise<DocsVerificationResult> {
	if (input.reason.trim().length === 0) {
		throw new Error("waive requires a non-empty reason");
	}
	const now = deps.now ?? (() => new Date());
	const record = await (deps.readRecord ?? readDocsRecord)(
		input.repoRoot,
		planSlugFromPath(input.planPath),
	);
	if (!record) {
		return {
			...OFF_RESULT,
			gated: true,
			warning: "no docs-verification record to waive",
		};
	}
	const updated: DocsVerificationRecord = {
		...record,
		updatedAt: now().toISOString(),
		units: record.units.map((unit) =>
			unit.slug === input.slug && unit.obligation
				? {
						...unit,
						obligation: {
							...unit.obligation,
							status: "waived" as const,
							reason: input.reason,
							updatedAt: now().toISOString(),
						},
					}
				: unit,
		),
	};
	await persist(input.repoRoot, updated, deps);
	return toResult(updated, deps.mode, deps.failClosed, false);
}

export function createDocsVerificationGuard(
	deps: DocsVerificationGuardDeps,
): DocsVerificationGuard {
	return {
		evaluate: async (input) => {
			try {
				return await evaluate(input, deps);
			} catch (error) {
				return {
					gated: true,
					allowed: true,
					decision: "uncertain",
					obligations: [],
					source: "degraded",
					reused: false,
					warning: `docs verification failed open: ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
		},
		waive: (input) => waive(input, deps),
	};
}
