/**
 * Shadow JSONL sink for the overengineering signal (plan Unit 5).
 *
 * Dedicated to this feature (not `utils/guard-log.ts`): rotation is by **line
 * count** (most recent 200), where `guard-log` rotates by byte size. Appends are
 * serialized through one promise chain and every failure is swallowed, because
 * telemetry must never affect a gate verdict.
 *
 * @module overengineering/shadow-log
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OverengineeringLogRecord } from "./types";

export const OVERENGINEERING_LOG_FILE =
	".context/compound-engineering/overengineering-shadow.jsonl";
const OVERENGINEERING_LOG_MAX_LINES = 200;

// ponytail: a single serialized chain; the composer writes at most one record
// per evaluation, so a queue abstraction would be unrequested machinery.
let chain: Promise<void> = Promise.resolve();

async function writeRecord(
	repoRoot: string,
	record: OverengineeringLogRecord,
): Promise<void> {
	const file = path.join(repoRoot, OVERENGINEERING_LOG_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	let lines: string[] = [];
	try {
		lines = (await readFile(file, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0);
	} catch {
		// missing log: start fresh
	}
	lines.push(JSON.stringify(record));
	const kept = lines.slice(-OVERENGINEERING_LOG_MAX_LINES);
	const temp = `${file}.tmp`;
	await writeFile(temp, `${kept.join("\n")}\n`, "utf8");
	await rename(temp, file);
}

/**
 * Append one shadow record, trimming to the most recent 200 lines.
 *
 * Never rejects: missing directories are created and write/rename failures are
 * swallowed.
 */
export function appendOverengineeringShadow(
	repoRoot: string,
	record: OverengineeringLogRecord,
): Promise<void> {
	const next = chain.then(async () => {
		try {
			await writeRecord(repoRoot, record);
		} catch {
			// ponytail: swallowed by design — the sink is best-effort telemetry.
		}
	});
	chain = next;
	return next;
}
