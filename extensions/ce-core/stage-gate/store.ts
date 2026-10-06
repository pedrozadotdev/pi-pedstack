// Stage gate record store: persistence, freshness, and mode resolution
// (plan Unit 4). Corrupt-safe readers, capped attempts, operator-only env.
import fs from "node:fs/promises";
import path from "node:path";
import { computeArtifactsHash, resolveArtifactPaths } from "./evidence";
import { stageRubrics } from "./rubrics";
import type {
	StageGateAttempt,
	StageGateMode,
	StageGateRecord,
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
 * Resolves `PEDSTACK_STAGE_GATE` (the only layer). Missing/empty/invalid
 * values resolve to `shadow`; never `off` by accident (R11).
 */
export function resolveStageGateMode(
	env: Record<string, string | undefined>,
): StageGateMode {
	const value = env.PEDSTACK_STAGE_GATE;
	if (value === "off") return "off";
	if (value === "enforce") return "enforce";
	return "shadow";
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

/** Baseline paths recorded on a schema-2 attempt; malformed values read as []. */
function baselinePathsOf(record: StageGateAttempt): string[] {
	const overengineering = record.overengineering;
	if (!overengineering || typeof overengineering !== "object") return [];
	const paths = (overengineering as { baselinePaths?: unknown }).baselinePaths;
	if (!Array.isArray(paths)) return [];
	return paths.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Recomputes the hash over the currently resolved artifact set plus the
 * record's baseline paths and compares it with the record. Edits, additions,
 * removals, and renames all invalidate (R7); a changed/removed baseline does
 * too. A malformed `overengineering` field is treated as absent (schema-1
 * tolerance).
 */
export async function isRecordFresh(
	repoRoot: string,
	record: StageGateAttempt,
): Promise<boolean> {
	const resolved = await resolveArtifactPaths(repoRoot, record.stage);
	const hash = await computeArtifactsHash(repoRoot, [
		...resolved.paths,
		...baselinePathsOf(record),
	]);
	return hash === record.artifactsHash;
}
