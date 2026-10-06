/**
 * Shadow JSONL sink for the Jev semantic stage guard.
 *
 * Writes one redacted {@link GuardLogRecord} per computed verdict directly via
 * `node:fs/promises` (never through the Pi `write` tool, so the workflow-state
 * block cannot recurse into logging). Appends are serialized through a
 * module-level promise chain; every failure is swallowed because logging must
 * never affect a guard verdict.
 *
 * @module guard-log
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { GuardLogRecord } from "./semantic-stage-guard";

export const GUARD_LOG_FILE =
	".context/compound-engineering/jev-stage-guard.jsonl";
export const GUARD_LOG_ROTATED_FILE =
	".context/compound-engineering/jev-stage-guard.1.jsonl";
export const MAX_GUARD_LOG_BYTES = 1_048_576;

export interface GuardLogOptions {
	maxBytes?: number;
}

// ponytail: a single serialized chain; the guard writes at most a few records
// per turn, so a queue abstraction would be unrequested machinery.
let chain: Promise<void> = Promise.resolve();

async function currentSize(file: string): Promise<number> {
	try {
		return (await stat(file)).size;
	} catch {
		return 0;
	}
}

async function writeRecord(
	repoRoot: string,
	record: GuardLogRecord,
	maxBytes: number,
): Promise<void> {
	const file = path.join(repoRoot, GUARD_LOG_FILE);
	const rotated = path.join(repoRoot, GUARD_LOG_ROTATED_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	if ((await currentSize(file)) >= maxBytes) {
		await rename(file, rotated);
	}
	await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Append one shadow record, rotating once at `maxBytes`.
 *
 * Never rejects: missing directories are created, write/rotate failures are
 * swallowed.
 */
export function appendGuardLog(
	repoRoot: string,
	record: GuardLogRecord,
	options: GuardLogOptions = {},
): Promise<void> {
	const maxBytes = options.maxBytes ?? MAX_GUARD_LOG_BYTES;
	const next = chain.then(async () => {
		try {
			await writeRecord(repoRoot, record, maxBytes);
		} catch {
			// ponytail: swallowed by design — the sink is best-effort telemetry.
		}
	});
	chain = next;
	return next;
}
