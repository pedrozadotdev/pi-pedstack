/**
 * Canonical JSON + short-hash helpers shared by handoff-readiness and drift.
 *
 * One implementation of "deterministic stringify" prevents the two modules from
 * drifting apart on persisted hashes. Pure: no I/O.
 *
 * @module canonical-json
 */

import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth; array order preserved. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",")}}`;
}

/** First 16 hex chars of the SHA-256 digest of `text`. */
export function sha256ShortHex(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
