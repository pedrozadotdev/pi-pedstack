// Handoff readiness record store (plan Unit 4). Persistence + freshness only;
// no policy. Corrupt-safe readers, one record per pair, best-effort shadow log.
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSlug } from "../utils/name-utils";
import { READINESS_QUESTION_IDS, THRESHOLDS_VERSION } from "./combine";
import type {
	ReadinessDimension,
	ReadinessLogRecord,
	ReadinessMode,
	ReadinessRecord,
	ReadinessSource,
	ReadinessVerdict,
} from "./types";

export const HANDOFF_READINESS_DIR =
	".context/compound-engineering/handoff-readiness";
export const READINESS_LOG_FILE =
	".context/compound-engineering/handoff-readiness.jsonl";
export const READINESS_LOG_ROTATED_FILE =
	".context/compound-engineering/handoff-readiness.1.jsonl";
export const MAX_READINESS_LOG_BYTES = 1_048_576;

const VERDICTS = new Set<ReadinessVerdict>([
	"continue",
	"improve_handoff",
	"preserve_current_session",
]);
const SOURCES = new Set<ReadinessSource>(["jev", "deterministic", "degraded"]);
const DIMENSION_IDS = new Set<string>(READINESS_QUESTION_IDS);

/** Slugified `<currentStage>-<nextStage>`, defaulting a missing next to current. */
export function pairSlug(
	currentStage?: string,
	nextStage?: string,
): string {
	const current = normalizeSlug(currentStage ?? "") || "unknown";
	const next = normalizeSlug(nextStage ?? "") || "current";
	return `${current}-${next}`;
}

export function readinessRecordPath(repoRoot: string, pair: string): string {
	return path.join(repoRoot, HANDOFF_READINESS_DIR, `${pair}.json`);
}

const STAGE_PAIR_PATTERN =
	/([0-9]{2}(?:-5)?-[a-z]+)-to-([0-9]{2}(?:-5)?-[a-z]+)$/;

/** Parses `…-<currentStage>-to-<nextStage>.md`; null when it does not match. */
export function stagePairFromHandoffPath(
	filePath: string,
): { currentStage: string; nextStage: string } | null {
	const base = path.basename(filePath);
	if (!base.endsWith(".md")) return null;
	const match = STAGE_PAIR_PATTERN.exec(base.slice(0, -3));
	if (!match) return null;
	return { currentStage: match[1], nextStage: match[2] };
}

function isDimension(value: unknown): value is ReadinessDimension {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		DIMENSION_IDS.has(entry.id) &&
		typeof entry.value === "number" &&
		typeof entry.confidence === "number" &&
		typeof entry.forced === "boolean"
	);
}

function isCorrection(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.dimension === "string" &&
		DIMENSION_IDS.has(entry.dimension) &&
		typeof entry.message === "string"
	);
}

/** Element-by-element validation; any mismatch is a corrupt record (null). */
function validateRecord(parsed: unknown): ReadinessRecord | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (record.schema !== 1) return null;
	if (typeof record.pair !== "string" || record.pair.length === 0) return null;
	if (typeof record.hash !== "string") return null;
	if (typeof record.thresholdsVersion !== "number") return null;
	if (typeof record.verdict !== "string" || !VERDICTS.has(record.verdict as ReadinessVerdict)) {
		return null;
	}
	if (typeof record.source !== "string" || !SOURCES.has(record.source as ReadinessSource)) {
		return null;
	}
	if (!Array.isArray(record.dimensions) || !record.dimensions.every(isDimension)) {
		return null;
	}
	if (
		!Array.isArray(record.corrections) ||
		!record.corrections.every(isCorrection)
	) {
		return null;
	}
	if (typeof record.updatedAt !== "string") return null;
	if (record.reason !== undefined && typeof record.reason !== "string") {
		return null;
	}
	// SAFETY: every field above was checked element-by-element; the shape now
	// matches ReadinessRecord and no unchecked field is exposed.
	return record as unknown as ReadinessRecord;
}

export async function readReadinessRecord(
	repoRoot: string,
	pair: string,
): Promise<ReadinessRecord | null> {
	try {
		const content = await readFile(readinessRecordPath(repoRoot, pair), "utf8");
		return validateRecord(JSON.parse(content));
	} catch {
		return null;
	}
}

export async function writeReadinessRecord(
	repoRoot: string,
	record: ReadinessRecord,
): Promise<string> {
	const filePath = readinessRecordPath(repoRoot, record.pair);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
	return filePath;
}

/**
 * Fresh iff schema, pair, hash, and thresholds version match **and** the record
 * came from Jev. Degraded/deterministic records are never reused, so an outage
 * or a pre-pass outcome can never disable later recomputation.
 */
export function isRecordFresh(
	record: ReadinessRecord | null,
	hash: string,
	pair: string,
): boolean {
	if (!record) return false;
	return (
		record.schema === 1 &&
		record.pair === pair &&
		record.hash === hash &&
		record.thresholdsVersion === THRESHOLDS_VERSION &&
		record.source === "jev"
	);
}

// ponytail: one serialized chain; the guard writes at most one record per save.
let chain: Promise<void> = Promise.resolve();

async function writeLog(
	repoRoot: string,
	record: ReadinessLogRecord,
): Promise<void> {
	const file = path.join(repoRoot, READINESS_LOG_FILE);
	const rotated = path.join(repoRoot, READINESS_LOG_ROTATED_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		size = 0;
	}
	if (size >= MAX_READINESS_LOG_BYTES) await rename(file, rotated);
	await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Append one shadow record, rotating once at the byte cap. Never rejects. */
export function appendReadinessLog(
	repoRoot: string,
	record: ReadinessLogRecord,
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
