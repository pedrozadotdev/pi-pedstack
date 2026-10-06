// Handoff readiness — record store, freshness, mode, pair, and shadow log
// (plan Unit 4).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THRESHOLDS_VERSION } from "../extensions/ce-core/handoff-readiness/combine.js";
import {
	HANDOFF_READINESS_DIR,
	MAX_READINESS_LOG_BYTES,
	READINESS_LOG_FILE,
	READINESS_LOG_ROTATED_FILE,
	appendReadinessLog,
	isRecordFresh,
	pairSlug,
	readReadinessRecord,
	readinessRecordPath,
	resolveReadinessFailClosed,
	resolveReadinessMode,
	stagePairFromHandoffPath,
	writeReadinessRecord,
} from "../extensions/ce-core/handoff-readiness/store.js";
import type {
	ReadinessRecord,
} from "../extensions/ce-core/handoff-readiness/types.js";

let root: string;

function record(over: Partial<ReadinessRecord> = {}): ReadinessRecord {
	return {
		schema: 1,
		pair: "02-plan-03-work",
		hash: "abcdef0123456789",
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: "continue",
		source: "jev",
		dimensions: [],
		corrections: [],
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

async function writeRaw(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-readiness-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("Unit 4 — mode and fail-closed resolution", () => {
	test("resolves mode from env, defaulting invalid values to shadow", () => {
		expect(resolveReadinessMode({})).toBe("shadow");
		expect(resolveReadinessMode({ PEDSTACK_HANDOFF_READINESS: "" })).toBe(
			"shadow",
		);
		expect(resolveReadinessMode({ PEDSTACK_HANDOFF_READINESS: "bogus" })).toBe(
			"shadow",
		);
		expect(resolveReadinessMode({ PEDSTACK_HANDOFF_READINESS: "off" })).toBe(
			"off",
		);
		expect(
			resolveReadinessMode({ PEDSTACK_HANDOFF_READINESS: "enforce" }),
		).toBe("enforce");
	});

	test("resolves fail-closed only for the literal 1", () => {
		expect(resolveReadinessFailClosed({})).toBe(false);
		expect(
			resolveReadinessFailClosed({
				PEDSTACK_HANDOFF_READINESS_FAILCLOSED: "true",
			}),
		).toBe(false);
		expect(
			resolveReadinessFailClosed({
				PEDSTACK_HANDOFF_READINESS_FAILCLOSED: "1",
			}),
		).toBe(true);
	});
});

describe("Unit 4 — pair slug and path parsing", () => {
	test("slugs a known pair", () => {
		expect(pairSlug("02-plan", "03-work")).toBe("02-plan-03-work");
	});

	test("defaults a missing next stage to current", () => {
		expect(pairSlug("02-plan", undefined)).toBe("02-plan-current");
	});

	test("neutralizes a traversal attempt", () => {
		expect(pairSlug("../../etc", "../../passwd")).toBe("etc-passwd");
		expect(readinessRecordPath("/repo", "etc-passwd")).toBe(
			path.join("/repo", HANDOFF_READINESS_DIR, "etc-passwd.json"),
		);
	});

	test("parses a dated handoff filename", () => {
		expect(
			stagePairFromHandoffPath(
				".context/compound-engineering/handoffs/2026-10-06T02-20-03-320Z-02-plan-to-03-work.md",
			),
		).toEqual({ currentStage: "02-plan", nextStage: "03-work" });
		expect(
			stagePairFromHandoffPath(
				".context/compound-engineering/handoffs/2026-10-06T02-20-03-320Z-04-5-debug-to-05-learn.md",
			),
		).toEqual({ currentStage: "04-5-debug", nextStage: "05-learn" });
	});

	test("returns null for a filename with no stage pair", () => {
		expect(stagePairFromHandoffPath("latest.md")).toBeNull();
		expect(stagePairFromHandoffPath("notes.txt")).toBeNull();
	});
});

describe("Unit 4 — record read/write", () => {
	test("round trips a valid record", async () => {
		const written = await writeReadinessRecord(root, record());
		expect(written).toBe(readinessRecordPath(root, "02-plan-03-work"));
		expect(await readReadinessRecord(root, "02-plan-03-work")).toEqual(
			record() as never,
		);
	});

	test("returns null for a missing record", async () => {
		expect(await readReadinessRecord(root, "02-plan-03-work")).toBeNull();
	});

	test("returns null (never throws) for corrupt or invalid records", async () => {
		const file = path.join(root, HANDOFF_READINESS_DIR, "02-plan-03-work.json");
		const invalid = [
			"{corrupt",
			JSON.stringify(record({ schema: 2 as unknown as 1 })),
			JSON.stringify(record({ verdict: "maybe" as never })),
			JSON.stringify({ schema: 1, pair: "02-plan-03-work" }),
			JSON.stringify(record({ corrections: "no" as never })),
			JSON.stringify(record({ dimensions: "no" as never })),
		];
		for (const content of invalid) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, content, "utf8");
			const result = await readReadinessRecord(root, "02-plan-03-work");
			expect({ content, result }).toEqual({ content, result: null });
		}
	});
});

describe("Unit 4 — freshness", () => {
	test("fresh only when schema, pair, hash, version, and source match", () => {
		expect(isRecordFresh(record(), "abcdef0123456789", "02-plan-03-work")).toBe(
			true,
		);
		expect(isRecordFresh(record(), "different", "02-plan-03-work")).toBe(false);
		expect(isRecordFresh(record(), "abcdef0123456789", "02-plan-04-review")).toBe(
			false,
		);
		expect(isRecordFresh(null, "abcdef0123456789", "02-plan-03-work")).toBe(
			false,
		);
	});

	test("a degraded or deterministic record is never fresh", () => {
		for (const source of ["degraded", "deterministic"] as const) {
			expect(
				isRecordFresh(
					record({ source }),
					"abcdef0123456789",
					"02-plan-03-work",
				),
			).toBe(false);
		}
	});

	test("a thresholds-version bump invalidates the record", () => {
		expect(
			isRecordFresh(
				record({ thresholdsVersion: THRESHOLDS_VERSION + 1 }),
				"abcdef0123456789",
				"02-plan-03-work",
			),
		).toBe(false);
	});
});

describe("Unit 4 — shadow log", () => {
	const logRecord = {
		ts: "2026-10-06T00:00:00.000Z",
		pair: "02-plan-03-work",
		mode: "shadow" as const,
		source: "jev" as const,
		verdict: "improve_handoff" as const,
		hash: "abcdef0123456789",
		dimensions: [],
		corrections: ["fix the next step"],
	};

	test("appends one JSON line", async () => {
		await appendReadinessLog(root, logRecord);
		const content = await fs.readFile(path.join(root, READINESS_LOG_FILE), "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual(logRecord as never);
	});

	test("rotates once at the byte cap", async () => {
		await writeRaw(READINESS_LOG_FILE, "x".repeat(MAX_READINESS_LOG_BYTES));
		await appendReadinessLog(root, logRecord);
		const rotated = await fs.readFile(
			path.join(root, READINESS_LOG_ROTATED_FILE),
			"utf8",
		);
		expect(rotated).toHaveLength(MAX_READINESS_LOG_BYTES);
		const live = await fs.readFile(path.join(root, READINESS_LOG_FILE), "utf8");
		expect(JSON.parse(live.trim())).toEqual(logRecord as never);
	});

	test("swallows an append failure", async () => {
		// A file where the directory should be makes mkdir/append fail.
		await writeRaw(READINESS_LOG_FILE, "blocker");
		await fs.rm(path.join(root, READINESS_LOG_FILE));
		await fs.mkdir(path.join(root, READINESS_LOG_FILE), { recursive: true });
		await expect(appendReadinessLog(root, logRecord)).resolves.toBeUndefined();
	});
});
