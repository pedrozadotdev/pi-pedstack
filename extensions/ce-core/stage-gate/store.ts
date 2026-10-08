// Stage gate record store: persistence, freshness, and mode resolution
// (plan Unit 4). Corrupt-safe readers, capped attempts, operator-only env.
import fs from "node:fs/promises";
import path from "node:path";
import { computeArtifactsHash, resolveArtifactPaths } from "./evidence";
import { stageRubrics } from "./rubrics";
import type {
	ReviewAction,
	StageGateAttempt,
	StageGateMode,
	StageGateRecord,
	StageGateVerdict,
	StageKey,
} from "./types";

export const ATTEMPT_CAP = 3;

const CONTEXT_DIR = ".context/compound-engineering";
const STAGE_GATES_DIR = `${CONTEXT_DIR}/stage-gates`;

const STAGE_KEYS = new Set<string>(Object.keys(stageRubrics));

export function isStageKey(value: unknown): value is StageKey {
	return typeof value === "string" && STAGE_KEYS.has(value);
}

/** Absolute path of the persisted record for one stage. */
export function stageGatePath(repoRoot: string, stage: StageKey): string {
	return path.join(repoRoot, STAGE_GATES_DIR, `${stage}.json`);
}

/**
 * True when a save ends a scored stage. Fails open for an unknown/missing
 * `currentStage`; an explicit same-stage checkpoint is never gated; an omitted
 * or unrecognized `nextStage` is treated as a completion save (R8).
 */
export function isCompletionSave(
	currentStage: unknown,
	nextStage: unknown,
): boolean {
	if (!isStageKey(currentStage)) return false;
	if (nextStage === currentStage) return false;
	return true;
}

async function readRecord(
	repoRoot: string,
	stage: StageKey,
): Promise<StageGateRecord | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(stageGatePath(repoRoot, stage), "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const attempts = (parsed as { attempts?: unknown }).attempts;
	if (!Array.isArray(attempts)) return null;
	return { stage, attempts: attempts as StageGateAttempt[] };
}

/** Newest attempt for a stage, or null when absent/corrupt. */
export async function readLatestRecord(
	repoRoot: string,
	stage: StageKey,
): Promise<StageGateAttempt | null> {
	const record = await readRecord(repoRoot, stage);
	if (!record || record.attempts.length === 0) return null;
	return record.attempts[record.attempts.length - 1];
}

/** All persisted attempts for a stage, oldest first. */
export async function readAttempts(
	repoRoot: string,
	stage: StageKey,
): Promise<StageGateAttempt[]> {
	const record = await readRecord(repoRoot, stage);
	return record?.attempts ?? [];
}

/**
 * The newest attempt, only when it is an enforcing `accept`. A shadow-produced
 * accept (`enforcing: false`) is never returned as an enforcing pass (L1).
 */
export async function readAcceptRecord(
	repoRoot: string,
	stage: StageKey,
): Promise<StageGateAttempt | null> {
	const latest = await readLatestRecord(repoRoot, stage);
	if (!latest || latest.verdict !== "accept" || latest.enforcing !== true) {
		return null;
	}
	return latest;
}

/**
 * The prior fresh review action for a stage, or null. Consumed read-only by
 * the evidence layer; a stale record contributes no review demand (Unit 4).
 * Reuses the single `isRecordFresh` predicate, never a weaker check.
 */
export async function resolvePriorGate(
	repoRoot: string,
	stage: StageKey,
): Promise<{
	verdict: StageGateVerdict;
	action: ReviewAction;
	updatedAt: string;
} | null> {
	const record = await readLatestRecord(repoRoot, stage);
	const action = record?.review?.action;
	const updatedAt = record?.updatedAt;
	if (!record || !action || typeof updatedAt !== "string") return null;
	try {
		if (!(await isRecordFresh(repoRoot, record))) return null;
	} catch {
		return null;
	}
	return { verdict: record.verdict, action, updatedAt };
}

/** Appends an attempt, keeping only the newest `ATTEMPT_CAP` records. */
export async function appendRecord(
	repoRoot: string,
	entry: StageGateAttempt,
): Promise<string> {
	const existing = await readRecord(repoRoot, entry.stage);
	const attempts = existing ? [...existing.attempts, entry] : [entry];
	const payload: StageGateRecord = {
		stage: entry.stage,
		attempts: attempts.slice(-ATTEMPT_CAP),
	};
	const filePath = stageGatePath(repoRoot, entry.stage);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
	return filePath;
}

/**
 * Remove every persisted stage-gate record. Called only when a genuinely new
 * workflow starts, so no stale `escalate` verdict (or prior review budget)
 * influences the new workflow; the continuation commands never clear it.
 */
export async function clearStageGateRecords(repoRoot: string): Promise<void> {
	await fs.rm(path.join(repoRoot, STAGE_GATES_DIR), {
		recursive: true,
		force: true,
	});
}

/** Baseline paths recorded on a schema-2 attempt; malformed values read as []. */
function baselinePathsOf(record: StageGateAttempt): string[] {
	const overengineering = record.overengineering;
	if (!overengineering || typeof overengineering !== "object") return [];
	const paths = (overengineering as { baselinePaths?: unknown }).baselinePaths;
	if (!Array.isArray(paths)) return [];
	return paths.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Recomputes the hash over the originally scored artifacts plus the
 * record's baseline paths and compares it with the record. Auto-discovered additions,
 * removals, and renames all invalidate (R7); a changed/removed baseline does
 * too. A malformed `overengineering` field is treated as absent (schema-1
 * tolerance).
 */
export async function isRecordFresh(
	repoRoot: string,
	record: StageGateAttempt,
): Promise<boolean> {
	// Explicit hints are an intentional restricted scoring set. Re-discovering
	// the full rubric here would hash files that the gate never scored.
	// Automatic selection still detects additions/removals via fresh discovery.
	const resolved = await resolveArtifactPaths(repoRoot, record.stage);
	const scored = record.artifacts;
	if (record.artifactSelection !== "hint") {
		const sameSet =
			resolved.paths.length === scored.length &&
			resolved.paths.every((entry, index) => entry === [...scored].sort()[index]);
		if (!sameSet) return false;
	}
	// computeArtifactsHash skips missing files. Check existence explicitly so a
	// removed hinted artifact cannot be silently omitted from the manifest.
	for (const rel of [...scored, ...baselinePathsOf(record)]) {
		try {
			if (!(await fs.stat(path.join(repoRoot, rel))).isFile()) return false;
		} catch {
			return false;
		}
	}
	const hash = await computeArtifactsHash(repoRoot, [
		...scored,
		...baselinePathsOf(record),
	]);
	return hash === record.artifactsHash;
}
