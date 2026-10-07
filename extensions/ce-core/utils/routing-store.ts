// Routing record store: corrupt-safe read/write of the per-stage routing
// decision, mirroring `stage-gate/store.ts`.
import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExecutionRole,
	RoutingReason,
	RoutingSource,
} from "./model-routing";

const CONTEXT_DIR = ".context/compound-engineering";
const ROUTING_DIR = `${CONTEXT_DIR}/routing`;

/** One persisted routing decision for a stage. */
export interface RoutingRecord {
	schema: 1;
	stage: string;
	role: ExecutionRole;
	reason: RoutingReason;
	source: RoutingSource;
	scores: Record<string, number> | null;
	weighted: number | null;
	confidence: number | null;
	attempts: number;
	/** Proactive Jev-triggered `sota` selections applied for this stage. */
	escalations: number;
	/** Retained attempts with verdict `revise` (bounded by the stage-gate ATTEMPT_CAP). */
	revisions: number;
	/** Retained attempts with verdict `review` (bounded by the stage-gate ATTEMPT_CAP). */
	reviews: number;
	updatedAt: string;
}

/** Absolute path of the persisted record for one stage. */
export function routingRecordPath(repoRoot: string, stage: string): string {
	return path.join(repoRoot, ROUTING_DIR, `${stage}.json`);
}

function isRoutingRecord(value: unknown): value is RoutingRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		obj.schema === 1 &&
		typeof obj.stage === "string" &&
		typeof obj.role === "string" &&
		typeof obj.reason === "string" &&
		typeof obj.source === "string" &&
		typeof obj.updatedAt === "string"
	);
}

/** Read the record for a stage, or null when absent/corrupt. */
export async function readRoutingRecord(
	repoRoot: string,
	stage: string,
): Promise<RoutingRecord | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			await fs.readFile(routingRecordPath(repoRoot, stage), "utf8"),
		);
	} catch {
		return null;
	}
	if (!isRoutingRecord(parsed)) return null;
	// Counters added after schema 1; a legacy record reads as zero counts.
	return {
		...parsed,
		revisions: typeof parsed.revisions === "number" ? parsed.revisions : 0,
		reviews: typeof parsed.reviews === "number" ? parsed.reviews : 0,
	};
}

/**
 * Remove every persisted routing record. Called only when a genuinely new
 * workflow starts, so the proactive escalation budget starts fresh; the
 * continuation commands never clear it.
 */
export async function clearRoutingRecords(repoRoot: string): Promise<void> {
	await fs.rm(path.join(repoRoot, ROUTING_DIR), { recursive: true, force: true });
}

/** Persist a record (creating parent directories) and return its path. */
export async function writeRoutingRecord(
	repoRoot: string,
	record: RoutingRecord,
): Promise<string> {
	const filePath = routingRecordPath(repoRoot, record.stage);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(record, null, 2));
	return filePath;
}
