// Handoff readiness guard (plan Unit 5). Owns precedence only; every I/O is
// injected. The deterministic floor (checklist + stage gate) is owned by the
// caller and is never consulted here.
import { existsSync } from "node:fs";
import path from "node:path";
import type { JevRuntime } from "../jev/types";
import { isCompletionSave } from "../stage-gate/store";
import { canonicalRel, isInside } from "../utils/repo-paths";
import {
	READINESS_JEV_TIMEOUT_MS,
	READINESS_QUESTION_IDS,
	THRESHOLDS_VERSION,
	buildReadinessRequest,
	canonicalizeState,
	deriveOutcome,
	enforceRequestBodyLimit,
	hashCanonical,
	normalizeState,
	prepass,
	readAnswers,
} from "./combine";
import {
	appendReadinessLog,
	isRecordFresh,
	pairSlug,
	readReadinessRecord,
	writeReadinessRecord,
} from "./store";
import type {
	ReadinessDimension,
	ReadinessGuardInput,
	ReadinessLogRecord,
	ReadinessMode,
	ReadinessOutcome,
	ReadinessRecord,
	ReadinessResult,
} from "./types";

export interface ReadinessGuardDeps {
	mode: ReadinessMode;
	failClosed: boolean;
	createJev: () => JevRuntime;
	now?: () => Date;
	fileExists?: (repoRoot: string, relPath: string) => boolean;
	readRecord?: (
		repoRoot: string,
		pair: string,
	) => Promise<ReadinessRecord | null>;
	writeRecord?: (repoRoot: string, record: ReadinessRecord) => string;
	logRecord?: (repoRoot: string, record: ReadinessLogRecord) => void;
}

export interface ReadinessGuard {
	evaluate(input: ReadinessGuardInput): Promise<ReadinessResult>;
}

/** Containment before any probe; a stat error counts as existing (fail-open). */
function missingActiveFiles(
	repoRoot: string,
	state: { activeFiles: string[] },
	fileExists: (repoRoot: string, relPath: string) => boolean,
): string[] {
	const missing: string[] = [];
	for (const file of state.activeFiles) {
		const rel = canonicalRel(repoRoot, file);
		if (!isInside(rel)) {
			missing.push(file);
			continue;
		}
		let exists: boolean;
		try {
			exists = fileExists(repoRoot, rel);
		} catch {
			exists = true;
		}
		if (!exists) missing.push(file);
	}
	return missing;
}

function outcomeFromRecord(record: ReadinessRecord): ReadinessOutcome {
	return {
		verdict: record.verdict,
		source: record.source,
		dimensions: record.dimensions,
		corrections: record.corrections,
		...(record.reason ? { reason: record.reason } : {}),
	};
}

function degradedOutcome(
	reason: string,
	forced: ReadinessDimension[],
): ReadinessOutcome {
	return {
		verdict: "improve_handoff",
		source: "degraded",
		dimensions: forced,
		corrections: [],
		reason,
	};
}

function degradedResult(
	base: ReadinessResult,
	outcome: ReadinessOutcome,
	mode: ReadinessMode,
	failClosed: boolean,
): ReadinessResult {
	const message = outcome.reason ?? "the semantic layer was unavailable";
	if (mode === "enforce" && failClosed) {
		return {
			...base,
			allowed: false,
			blocker:
				`Cannot save cross-stage handoff: handoff readiness is degraded ` +
				`(${message}) and PEDSTACK_HANDOFF_READINESS_FAILCLOSED=1.`,
		};
	}
	return {
		...base,
		allowed: true,
		warning: `handoff readiness degraded: ${message}`,
	};
}

function nonContinueResult(
	base: ReadinessResult,
	outcome: ReadinessOutcome,
	mode: ReadinessMode,
): ReadinessResult {
	const summary =
		outcome.corrections.length > 0
			? outcome.corrections.map((entry) => entry.message).join(" ")
			: (outcome.reason ?? outcome.verdict);
	if (mode === "enforce") {
		return {
			...base,
			allowed: false,
			blocker:
				`Cannot save cross-stage handoff: handoff readiness verdict ` +
				`"${outcome.verdict}". ${summary}`,
		};
	}
	return {
		...base,
		allowed: true,
		warning: `handoff readiness warning: ${summary}`,
	};
}

/** Map a derived outcome to the caller-facing result for the active mode. */
function toResult(
	gated: boolean,
	outcome: ReadinessOutcome,
	mode: ReadinessMode,
	failClosed: boolean,
): ReadinessResult {
	if (!gated) return { gated: false, allowed: true };
	const base: ReadinessResult = {
		gated,
		allowed: true,
		verdict: outcome.verdict,
		source: outcome.source,
		dimensions: outcome.dimensions,
		corrections: outcome.corrections,
		...(outcome.reason ? { reason: outcome.reason } : {}),
	};
	if (outcome.source === "degraded") {
		return degradedResult(base, outcome, mode, failClosed);
	}
	if (outcome.verdict === "continue") return base;
	return nonContinueResult(base, outcome, mode);
}

/** Record + log writes are best-effort; a failure never changes the verdict. */
async function persist(
	repoRoot: string,
	pair: string,
	hash: string,
	outcome: ReadinessOutcome,
	deps: ReadinessGuardDeps,
): Promise<void> {
	const updatedAt = (deps.now ?? (() => new Date()))().toISOString();
	const record: ReadinessRecord = {
		schema: 1,
		pair,
		hash,
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: outcome.verdict,
		source: outcome.source,
		...(outcome.reason ? { reason: outcome.reason } : {}),
		dimensions: outcome.dimensions,
		corrections: outcome.corrections,
		updatedAt,
	};
	try {
		if (deps.writeRecord) await deps.writeRecord(repoRoot, record);
		else await writeReadinessRecord(repoRoot, record);
	} catch {
		// ponytail: swallowed — the verdict is already decided.
	}

	const log: ReadinessLogRecord = {
		ts: updatedAt,
		pair,
		mode: deps.mode,
		source: outcome.source,
		verdict: outcome.verdict,
		hash,
		dimensions: outcome.dimensions.map((entry) => ({
			id: entry.id,
			value: entry.value,
			confidence: entry.confidence,
			forced: entry.forced,
		})),
		corrections: outcome.corrections.map((entry) => entry.message),
	};
	try {
		if (deps.logRecord) await deps.logRecord(repoRoot, log);
		else await appendReadinessLog(repoRoot, log);
	} catch {
		// ponytail: swallowed — the sink is best-effort telemetry.
	}
}

interface GuardComputation {
	outcome: ReadinessOutcome;
	reused: boolean;
	hash: string;
	pair: string;
}

/** Deterministic pre-pass -> freshness reuse (source `jev`) -> Jev decide. */
async function computeReadiness(
	input: ReadinessGuardInput,
	deps: ReadinessGuardDeps,
	fileExists: (repoRoot: string, relPath: string) => boolean,
): Promise<GuardComputation> {
	const normalized = normalizeState(input.state);
	const hash = hashCanonical(canonicalizeState(normalized));
	const pair = pairSlug(input.currentStage, input.nextStage);
	const missing = missingActiveFiles(input.repoRoot, normalized, fileExists);
	const { forced, forcesNonContinue } = prepass(normalized, missing);

	if (forcesNonContinue) {
		return {
			outcome: deriveOutcome(forced, {
				nextStage: input.nextStage,
				missingFiles: missing,
			}),
			reused: false,
			hash,
			pair,
		};
	}

	const readRecord = deps.readRecord ?? readReadinessRecord;
	const record = await readRecord(input.repoRoot, pair);
	if (isRecordFresh(record, hash, pair)) {
		return {
			outcome: outcomeFromRecord(record as ReadinessRecord),
			reused: true,
			hash,
			pair,
		};
	}

	try {
		const asked = READINESS_QUESTION_IDS.filter(
			(id) => !forced.some((entry) => entry.id === id),
		);
		const request = buildReadinessRequest(normalized, asked);
		enforceRequestBodyLimit(request);
		const result = await deps.createJev().decide(request, {
			timeoutMs: READINESS_JEV_TIMEOUT_MS,
		});
		const answers = readAnswers(result, forced);
		return {
			outcome:
				typeof answers === "string"
					? degradedOutcome(answers, forced)
					: deriveOutcome(answers, {
							nextStage: input.nextStage,
							missingFiles: missing,
						}),
			reused: false,
			hash,
			pair,
		};
	} catch (error) {
		return {
			outcome: degradedOutcome(
				error instanceof Error ? error.message : String(error),
				forced,
			),
			reused: false,
			hash,
			pair,
		};
	}
}

/**
 * Precedence: off/unknown/same-stage → not gated; deterministic pre-pass
 * (filesystem included) → freshness reuse (source `jev` only) → Jev decide.
 * Shadow warns, enforce blocks, degrade fails open unless failClosed.
 */
async function evaluateReadiness(
	input: ReadinessGuardInput,
	deps: ReadinessGuardDeps,
	fileExists: (repoRoot: string, relPath: string) => boolean,
): Promise<ReadinessResult> {
	if (deps.mode === "off") return { gated: false, allowed: true };
	if (!isCompletionSave(input.currentStage, input.nextStage)) {
		return { gated: false, allowed: true };
	}

	try {
		const { outcome, reused, hash, pair } = await computeReadiness(
			input,
			deps,
			fileExists,
		);
		if (!reused) await persist(input.repoRoot, pair, hash, outcome, deps);
		return toResult(true, outcome, deps.mode, deps.failClosed);
	} catch (error) {
		return {
			gated: true,
			allowed: true,
			warning: `handoff readiness failed open: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

export function createReadinessGuard(
	deps: ReadinessGuardDeps,
): ReadinessGuard {
	const fileExists =
		deps.fileExists ??
		((repoRoot: string, relPath: string) =>
			existsSync(path.join(repoRoot, relPath)));
	return {
		evaluate: (input: ReadinessGuardInput) =>
			evaluateReadiness(input, deps, fileExists),
	};
}
