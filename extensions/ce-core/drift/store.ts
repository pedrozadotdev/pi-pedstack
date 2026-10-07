// Drift record store + policy resolution (plan Unit 3). Persistence, freshness,
// and mode/session resolution only. Corrupt-safe readers, one record per stage,
// best-effort append-only shadow log.
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256ShortHex } from "../utils/canonical-json";
import { normalizeSlug } from "../utils/name-utils";
import { DRIFT_QUESTION_IDS, DRIFT_RECORD_TTL_MS, THRESHOLDS_VERSION } from "./combine";
import type {
	DriftDimensionId,
	DriftMode,
	DriftSource,
	DriftVerdict,
} from "./types";

export const DRIFT_DIR = ".context/compound-engineering/drift";
export const DRIFT_LOG_FILE = ".context/compound-engineering/drift.jsonl";
export const DRIFT_LOG_ROTATED_FILE =
	".context/compound-engineering/drift.1.jsonl";
export const MAX_DRIFT_LOG_BYTES = 1_048_576;

/** One persisted drift judgment per stage (latest state; AD-4). */
export interface DriftRecord {
	schema: 1;
	stage: string;
	sessionKey: string;
	turnIndex: number;
	signature: string;
	thresholdsVersion: number;
	verdict: DriftVerdict;
	source: DriftSource;
	triggered: DriftDimensionId[];
	correction?: string;
	reason?: string;
	consecutiveMild: number;
	consecutiveNoDrift: number;
	updatedAt: string;
}

/** One redacted shadow-log line. */
export interface DriftLogRecord {
	ts: string;
	stage: string;
	sessionKey: string;
	mode: DriftMode;
	source: DriftSource;
	verdict: DriftVerdict;
	signature: string;
	triggered: DriftDimensionId[];
	dimensions: { id: DriftDimensionId; value: number; confidence: number }[];
	jevCalled: boolean;
	statusWriteFailed?: boolean;
	reason?: string;
	correction?: string;
}

const VERDICTS = new Set<DriftVerdict>([
	"no_drift",
	"mild_drift",
	"strong_drift",
]);
const SOURCES = new Set<DriftSource>(["jev", "deterministic", "degraded"]);
const DIMENSION_IDS = new Set<string>(DRIFT_QUESTION_IDS);

export function driftRecordPath(repoRoot: string, stage: string): string {
	return path.join(repoRoot, driftRecordRelPath(stage));
}

/** Repo-relative record path for operator-facing messages. */
export function driftRecordRelPath(stage: string): string {
	const slug = normalizeSlug(stage) || "unknown";
	return `${DRIFT_DIR}/${slug}.json`;
}

/**
 * Per-stage last-evaluation health marker (D2). Distinct from `DriftRecord`
 * (the verdict state) and `DriftLogRecord` (shadow telemetry). Written only by
 * the guard in `enforce` for `jev`/`degraded` outcomes.
 */
export interface DriftStatus {
	schema: 1;
	stage: string;
	sessionKey: string;
	thresholdsVersion: number;
	degraded: boolean;
	updatedAt: string;
}

/** Single source of truth for the drift-status path (D2). */
export function driftStatusPath(repoRoot: string, stage: string): string {
	const slug = normalizeSlug(stage) || "unknown";
	return path.join(repoRoot, DRIFT_DIR, `${slug}.status.json`);
}

/** Repo-relative status path for operator-facing messages. */
export function driftStatusRelPath(stage: string): string {
	const slug = normalizeSlug(stage) || "unknown";
	return `${DRIFT_DIR}/${slug}.status.json`;
}

// ponytail: Module-level session key for the live session; the handoff tool has
// no `ctx`, so it reads this mirror (same pattern as active-stage.ts).
let currentSessionKey = "";

export function setCurrentDriftSessionKey(sessionKey: string): void {
	currentSessionKey = typeof sessionKey === "string" ? sessionKey : "";
}

export function getCurrentDriftSessionKey(): string {
	return currentSessionKey;
}

function callString(
	manager: Record<string, unknown> | null,
	method: string,
): string | null {
	if (!manager || typeof manager[method] !== "function") return null;
	try {
		const value = (manager[method] as () => unknown).call(manager);
		return typeof value === "string" && value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

/** AD-1b resolver: id → file → dir:leaf → `unknown-session`. Never throws. */
export function resolveSessionKey(sessionManager: unknown): string {
	const manager =
		sessionManager && typeof sessionManager === "object"
			? (sessionManager as Record<string, unknown>)
			: null;

	const id = callString(manager, "getSessionId");
	if (id) return id;
	const file = callString(manager, "getSessionFile");
	if (file) return file;
	const dir = callString(manager, "getSessionDir");
	const leaf = callString(manager, "getLeafId");
	if (dir !== null || leaf !== null) return `${dir ?? ""}:${leaf ?? ""}`;
	return "unknown-session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isDimensionId(value: unknown): value is DriftDimensionId {
	return typeof value === "string" && DIMENSION_IDS.has(value);
}

function isVerdict(value: unknown): value is DriftVerdict {
	return typeof value === "string" && VERDICTS.has(value as DriftVerdict);
}

function isSource(value: unknown): value is DriftSource {
	return typeof value === "string" && SOURCES.has(value as DriftSource);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

/** Identity + provenance fields. */
function hasValidMeta(record: Record<string, unknown>): boolean {
	return (
		record.schema === 1 &&
		isNonEmptyString(record.stage) &&
		isNonEmptyString(record.sessionKey) &&
		typeof record.turnIndex === "number" &&
		typeof record.signature === "string" &&
		typeof record.thresholdsVersion === "number"
	);
}

/** Verdict + source enums and the triggered-dimension list. */
function hasValidVerdict(record: Record<string, unknown>): boolean {
	return (
		isVerdict(record.verdict) &&
		isSource(record.source) &&
		Array.isArray(record.triggered) &&
		record.triggered.every(isDimensionId)
	);
}

/** Streak counters, timestamp, and optional free-text fields. */
function hasValidState(record: Record<string, unknown>): boolean {
	return (
		typeof record.consecutiveMild === "number" &&
		typeof record.consecutiveNoDrift === "number" &&
		typeof record.updatedAt === "string" &&
		isOptionalString(record.correction) &&
		isOptionalString(record.reason)
	);
}

/** Element-by-element validation; any mismatch is a corrupt record (null). */
function validateRecord(parsed: unknown): DriftRecord | null {
	if (!isRecord(parsed)) return null;
	const record = parsed;
	if (!hasValidMeta(record)) return null;
	if (!hasValidVerdict(record)) return null;
	if (!hasValidState(record)) return null;
	// SAFETY: every field above was checked element-by-element; the shape now
	// matches DriftRecord and no unchecked field is exposed.
	return record as unknown as DriftRecord;
}

export async function readDriftRecord(
	repoRoot: string,
	stage: string,
): Promise<DriftRecord | null> {
	try {
		const content = await readFile(driftRecordPath(repoRoot, stage), "utf8");
		return validateRecord(JSON.parse(content));
	} catch {
		return null;
	}
}

export async function writeDriftRecord(
	repoRoot: string,
	record: DriftRecord,
): Promise<string> {
	const filePath = driftRecordPath(repoRoot, record.stage);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
	return filePath;
}

/** Element-by-element validation; any mismatch is a corrupt status (null). */
function validateStatus(parsed: unknown): DriftStatus | null {
	if (!isRecord(parsed)) return null;
	const status = parsed;
	if (
		status.schema !== 1 ||
		!isNonEmptyString(status.stage) ||
		!isNonEmptyString(status.sessionKey) ||
		typeof status.thresholdsVersion !== "number" ||
		typeof status.degraded !== "boolean" ||
		typeof status.updatedAt !== "string"
	) {
		return null;
	}
	// SAFETY: every field above was checked element-by-element; the shape now
	// matches DriftStatus and no unchecked field is exposed.
	return status as unknown as DriftStatus;
}

/** Corrupt-safe read; any failure is a missing status (fail-open). */
export async function readDriftStatus(
	repoRoot: string,
	stage: string,
): Promise<DriftStatus | null> {
	try {
		const content = await readFile(driftStatusPath(repoRoot, stage), "utf8");
		return validateStatus(JSON.parse(content));
	} catch {
		return null;
	}
}

export async function writeDriftStatus(
	repoRoot: string,
	status: DriftStatus,
): Promise<string> {
	const filePath = driftStatusPath(repoRoot, status.stage);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(status, null, 2), "utf8");
	return filePath;
}

/** Best-effort delete; a missing file is a no-op. */
export async function clearDriftRecord(
	repoRoot: string,
	stage: string,
): Promise<void> {
	try {
		await unlink(driftRecordPath(repoRoot, stage));
	} catch {
		// ponytail: swallowed — missing record already means "no block".
	}
}

/**
 * The only freshness predicate (AD-4). Fresh iff schema/stage/session/version
 * match, the source is `jev`, and the record is within the TTL. Degraded and
 * deterministic records are never reused.
 */
export function isDriftRecordFresh(
	record: DriftRecord | null,
	stage: string,
	sessionKey: string,
	now: Date = new Date(),
): boolean {
	if (!record) return false;
	if (record.schema !== 1 || record.stage !== stage) return false;
	if (record.sessionKey !== sessionKey) return false;
	if (record.thresholdsVersion !== THRESHOLDS_VERSION) return false;
	if (record.source !== "jev") return false;
	const updatedAt = Date.parse(record.updatedAt);
	if (Number.isNaN(updatedAt)) return false;
	const age = now.getTime() - updatedAt;
	return age <= DRIFT_RECORD_TTL_MS;
}

/** A fresh `jev` strong verdict blocks a cross-stage completion save (AD-5). */
export function shouldBlockCompletion(
	record: DriftRecord | null,
	stage: string,
	sessionKey: string,
	now: Date = new Date(),
): boolean {
	return (
		isDriftRecordFresh(record, stage, sessionKey, now) &&
		record?.verdict === "strong_drift"
	);
}

/**
 * The only drift-status freshness predicate (freshness card). Fresh iff
 * schema/stage/session/version match, the session key is resolved, and the
 * status is within the shared 6 h TTL. Degraded state is not a freshness input.
 */
export function isDriftStatusFresh(
	status: DriftStatus | null,
	stage: string,
	sessionKey: string,
	now: Date = new Date(),
): boolean {
	if (!status) return false;
	if (status.schema !== 1 || status.stage !== stage) return false;
	if (status.sessionKey !== sessionKey) return false;
	if (sessionKey === "" || sessionKey === "unknown-session") return false;
	if (status.thresholdsVersion !== THRESHOLDS_VERSION) return false;
	const updatedAt = Date.parse(status.updatedAt);
	if (Number.isNaN(updatedAt)) return false;
	return now.getTime() - updatedAt <= DRIFT_RECORD_TTL_MS;
}

// ponytail: one serialized chain; the guard writes at most one record per turn.
let chain: Promise<void> = Promise.resolve();

async function writeLog(
	repoRoot: string,
	record: DriftLogRecord,
): Promise<void> {
	const file = path.join(repoRoot, DRIFT_LOG_FILE);
	const rotated = path.join(repoRoot, DRIFT_LOG_ROTATED_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		size = 0;
	}
	if (size >= MAX_DRIFT_LOG_BYTES) await rename(file, rotated);
	const redacted: DriftLogRecord = {
		...record,
		sessionKey: sha256ShortHex(record.sessionKey),
	};
	await appendFile(file, `${JSON.stringify(redacted)}\n`, "utf8");
}

/** Append one shadow record, rotating once at the byte cap. Never rejects. */
export function appendDriftLog(
	repoRoot: string,
	record: DriftLogRecord,
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
