// Unit 3 — drift store: mode resolution, session-key resolver, record
// read/write/validate/freshness, isolation/TTL, and the shadow log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	DRIFT_RECORD_TTL_MS,
	THRESHOLDS_VERSION,
} from "../extensions/ce-core/drift/combine.js";
import {
	DRIFT_DIR,
	DRIFT_LOG_FILE,
	DRIFT_LOG_ROTATED_FILE,
	MAX_DRIFT_LOG_BYTES,
	appendDriftLog,
	clearDriftRecord,
	driftRecordPath,
	driftRecordRelPath,
	driftStatusPath,
	driftStatusRelPath,
	getCurrentDriftSessionKey,
	isDriftRecordFresh,
	isDriftStatusFresh,
	readDriftRecord,
	readDriftStatus,
	resolveDriftFailClosed,
	resolveDriftMode,
	resolveSessionKey,
	setCurrentDriftSessionKey,
	shouldBlockCompletion,
	writeDriftRecord,
	writeDriftStatus,
	type DriftLogRecord,
	type DriftRecord,
	type DriftStatus,
} from "../extensions/ce-core/drift/store.js";

let root: string;

function record(over: Partial<DriftRecord> = {}): DriftRecord {
	return {
		schema: 1,
		stage: "03-work",
		sessionKey: "sid-1",
		turnIndex: 3,
		signature: "abcdef0123456789",
		thresholdsVersion: THRESHOLDS_VERSION,
		verdict: "no_drift",
		source: "jev",
		triggered: [],
		consecutiveMild: 0,
		consecutiveNoDrift: 0,
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

async function writeRaw(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
}

const NOW = new Date("2026-10-06T01:00:00.000Z");

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "drift-store-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("mode and fail-closed resolution", () => {
	test("resolves mode, defaulting missing/invalid to shadow", () => {
		expect(resolveDriftMode({})).toBe("shadow");
		expect(resolveDriftMode({ PEDSTACK_DRIFT_GUARD: "" })).toBe("shadow");
		expect(resolveDriftMode({ PEDSTACK_DRIFT_GUARD: "wat" })).toBe("shadow");
		expect(resolveDriftMode({ PEDSTACK_DRIFT_GUARD: "off" })).toBe("off");
		expect(resolveDriftMode({ PEDSTACK_DRIFT_GUARD: "enforce" })).toBe(
			"enforce",
		);
	});

	test("resolves fail-closed only for the literal 1", () => {
		expect(resolveDriftFailClosed({})).toBe(false);
		expect(
			resolveDriftFailClosed({ PEDSTACK_DRIFT_GUARD_FAILCLOSED: "true" }),
		).toBe(false);
		expect(
			resolveDriftFailClosed({ PEDSTACK_DRIFT_GUARD_FAILCLOSED: "1" }),
		).toBe(true);
	});
});

describe("session-key resolver (AD-1b)", () => {
	test("prefers getSessionId", () => {
		expect(resolveSessionKey({ getSessionId: () => "sid" })).toBe("sid");
	});

	test("falls back to getSessionFile", () => {
		expect(
			resolveSessionKey({ getSessionFile: () => "/tmp/s.jsonl" }),
		).toBe("/tmp/s.jsonl");
	});

	test("falls back to dir + leaf", () => {
		expect(
			resolveSessionKey({
				getSessionDir: () => "/tmp",
				getLeafId: () => "leaf",
			}),
		).toBe("/tmp:leaf");
	});

	test("resolves a stable key from a leaf-only mock", () => {
		expect(resolveSessionKey({ getLeafId: () => "leaf1" })).toBe(":leaf1");
	});

	test("returns unknown-session for a throwing or empty manager", () => {
		expect(
			resolveSessionKey({
				getSessionId: () => {
					throw new Error("boom");
				},
			}),
		).toBe("unknown-session");
		expect(resolveSessionKey({})).toBe("unknown-session");
		expect(resolveSessionKey(null)).toBe("unknown-session");
	});

	test("mirrors the current session key at module level", () => {
		setCurrentDriftSessionKey("abc");
		expect(getCurrentDriftSessionKey()).toBe("abc");
		setCurrentDriftSessionKey("");
		expect(getCurrentDriftSessionKey()).toBe("");
	});
});

describe("record path and round-trip", () => {
	test("slugs the stage into the drift directory", () => {
		expect(driftRecordPath("/repo", "03-work")).toBe(
			path.join("/repo", DRIFT_DIR, "03-work.json"),
		);
		expect(driftRecordPath("/repo", "../../etc")).toBe(
			path.join("/repo", DRIFT_DIR, "etc.json"),
		);
	});

	test("derives the repo-relative record path from the stage slug", () => {
		expect(driftRecordRelPath("02-plan")).toBe(
			`${DRIFT_DIR}/02-plan.json`,
		);
		expect(driftRecordRelPath("")).toBe(`${DRIFT_DIR}/unknown.json`);
	});

	test("round-trips a written record", async () => {
		await writeDriftRecord(root, record({ verdict: "mild_drift" }));
		const read = await readDriftRecord(root, "03-work");
		expect(read?.verdict).toBe("mild_drift");
		expect(read?.sessionKey).toBe("sid-1");
	});

	test("clear removes the record", async () => {
		await writeDriftRecord(root, record());
		await clearDriftRecord(root, "03-work");
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});

	test("returns null for a missing record", async () => {
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});
});

describe("element-by-element validation", () => {
	test("returns null for corrupt JSON", async () => {
		await writeRaw(`${DRIFT_DIR}/03-work.json`, "{not json");
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});

	test("returns null for a wrong schema", async () => {
		await writeRaw(
			`${DRIFT_DIR}/03-work.json`,
			JSON.stringify({ ...record(), schema: 2 }),
		);
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});

	test("returns null for an unknown verdict or source", async () => {
		await writeRaw(
			`${DRIFT_DIR}/03-work.json`,
			JSON.stringify({ ...record(), verdict: "meh" }),
		);
		expect(await readDriftRecord(root, "03-work")).toBeNull();
		await writeRaw(
			`${DRIFT_DIR}/03-work.json`,
			JSON.stringify({ ...record(), source: "magic" }),
		);
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});

	test("returns null when consecutiveMild is missing", async () => {
		const { consecutiveMild: _drop, ...rest } = record();
		await writeRaw(`${DRIFT_DIR}/03-work.json`, JSON.stringify(rest));
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});

	test("returns null for a bad triggered id", async () => {
		await writeRaw(
			`${DRIFT_DIR}/03-work.json`,
			JSON.stringify({ ...record(), triggered: ["nope"] }),
		);
		expect(await readDriftRecord(root, "03-work")).toBeNull();
	});
});

describe("isDriftRecordFresh", () => {
	test("is fresh for a matching jev record within the TTL", () => {
		expect(
			isDriftRecordFresh(record(), "03-work", "sid-1", NOW),
		).toBe(true);
	});

	test("rejects a different session (isolation)", () => {
		expect(
			isDriftRecordFresh(record(), "03-work", "other", NOW),
		).toBe(false);
	});

	test("rejects a different stage", () => {
		expect(
			isDriftRecordFresh(record(), "04-review", "sid-1", NOW),
		).toBe(false);
	});

	test("rejects degraded and deterministic sources", () => {
		expect(
			isDriftRecordFresh(record({ source: "degraded" }), "03-work", "sid-1", NOW),
		).toBe(false);
		expect(
			isDriftRecordFresh(
				record({ source: "deterministic" }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});

	test("rejects an expired record", () => {
		const old = new Date(NOW.getTime() - DRIFT_RECORD_TTL_MS - 1).toISOString();
		expect(
			isDriftRecordFresh(record({ updatedAt: old }), "03-work", "sid-1", NOW),
		).toBe(false);
	});

	test("rejects a thresholds version mismatch", () => {
		expect(
			isDriftRecordFresh(
				record({ thresholdsVersion: THRESHOLDS_VERSION + 1 }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});

	test("treats null as not fresh", () => {
		expect(isDriftRecordFresh(null, "03-work", "sid-1", NOW)).toBe(false);
	});
});

describe("shouldBlockCompletion", () => {
	test("blocks a strong, fresh jev record", () => {
		expect(
			shouldBlockCompletion(
				record({ verdict: "strong_drift" }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(true);
	});

	test("does not block mild or no-drift records", () => {
		expect(
			shouldBlockCompletion(
				record({ verdict: "mild_drift" }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
		expect(
			shouldBlockCompletion(record(), "03-work", "sid-1", NOW),
		).toBe(false);
	});

	test("does not block a degraded strong-shaped record", () => {
		expect(
			shouldBlockCompletion(
				record({ verdict: "strong_drift", source: "degraded" }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});

	test("does not block an expired strong record", () => {
		const old = new Date(NOW.getTime() - DRIFT_RECORD_TTL_MS - 1).toISOString();
		expect(
			shouldBlockCompletion(
				record({ verdict: "strong_drift", updatedAt: old }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});
});

describe("drift status store", () => {
	function status(over: Partial<DriftStatus> = {}): DriftStatus {
		return {
			schema: 1,
			stage: "03-work",
			sessionKey: "sid-1",
			thresholdsVersion: THRESHOLDS_VERSION,
			degraded: false,
			updatedAt: "2026-10-06T00:00:00.000Z",
			...over,
		};
	}

	test("derives the .status.json path from the stage slug", () => {
		expect(driftStatusPath("/repo", "03-work")).toBe(
			path.join("/repo", DRIFT_DIR, "03-work.status.json"),
		);
		expect(driftStatusPath("/repo", "../../etc")).toBe(
			path.join("/repo", DRIFT_DIR, "etc.status.json"),
		);
		expect(driftStatusRelPath("03-work")).toBe(
			`${DRIFT_DIR}/03-work.status.json`,
		);
	});

	test("round-trips a written status", async () => {
		await writeDriftStatus(root, status({ degraded: true }));
		const read = await readDriftStatus(root, "03-work");
		expect(read).toEqual(status({ degraded: true }));
	});

	test("returns null for a missing status file", async () => {
		expect(await readDriftStatus(root, "03-work")).toBeNull();
	});

	test("returns null for corrupt JSON and wrong-shape fields", async () => {
		const cases: unknown[] = [
			"{not json",
			{ ...status(), schema: 2 },
			{ ...status(), stage: "" },
			{ ...status(), sessionKey: "" },
			{ ...status(), thresholdsVersion: "2" },
			{ ...status(), degraded: "false" },
			{ ...status(), updatedAt: 123 },
		];
		for (const [index, payload] of cases.entries()) {
			await writeRaw(
				`${DRIFT_DIR}/03-work.status.json`,
				typeof payload === "string" ? payload : JSON.stringify(payload),
			);
			expect({ index, read: await readDriftStatus(root, "03-work") }).toEqual({
				index,
				read: null,
			});
		}
	});

	test("fails open (null) when the status path is unreadable", async () => {
		await fs.mkdir(path.join(root, DRIFT_DIR, "03-work.status.json"), {
			recursive: true,
		});
		expect(await readDriftStatus(root, "03-work")).toBeNull();
	});

	test("isDriftStatusFresh: a matching status is fresh", () => {
		expect(
			isDriftStatusFresh(status(), "03-work", "sid-1", NOW),
		).toBe(true);
	});

	test("isDriftStatusFresh: stage, session, and version mismatches are not fresh", () => {
		expect(
			isDriftStatusFresh(status(), "04-review", "sid-1", NOW),
		).toBe(false);
		expect(
			isDriftStatusFresh(status(), "03-work", "other", NOW),
		).toBe(false);
		expect(
			isDriftStatusFresh(
				status({ thresholdsVersion: THRESHOLDS_VERSION + 1 }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});

	test("isDriftStatusFresh: an empty or unknown session key is not fresh", () => {
		expect(isDriftStatusFresh(status({ sessionKey: "" }), "03-work", "", NOW)).toBe(
			false,
		);
		expect(
			isDriftStatusFresh(
				status({ sessionKey: "unknown-session" }),
				"03-work",
				"unknown-session",
				NOW,
			),
		).toBe(false);
	});

	test("isDriftStatusFresh: expired or unparseable timestamps are not fresh", () => {
		const expired = new Date(
			NOW.getTime() - DRIFT_RECORD_TTL_MS - 1,
		).toISOString();
		expect(
			isDriftStatusFresh(status({ updatedAt: expired }), "03-work", "sid-1", NOW),
		).toBe(false);
		expect(
			isDriftStatusFresh(
				status({ updatedAt: "not-a-date" }),
				"03-work",
				"sid-1",
				NOW,
			),
		).toBe(false);
	});

	test("isDriftStatusFresh: null is never fresh", () => {
		expect(isDriftStatusFresh(null, "03-work", "sid-1", NOW)).toBe(false);
	});
});

describe("appendDriftLog", () => {
	function logEntry(): DriftLogRecord {
		return {
			ts: "2026-10-06T00:00:00.000Z",
			stage: "03-work",
			sessionKey: "sid-1",
			mode: "shadow",
			source: "jev",
			verdict: "mild_drift",
			signature: "abcdef0123456789",
			triggered: ["in_stage_scope"],
			dimensions: [{ id: "in_stage_scope", value: 0.1, confidence: 1 }],
			jevCalled: true,
		};
	}

	test("writes one JSON line with the frozen fields", async () => {
		await appendDriftLog(root, logEntry());
		const content = await fs.readFile(path.join(root, DRIFT_LOG_FILE), "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.stage).toBe("03-work");
		expect(parsed.verdict).toBe("mild_drift");
		expect(parsed.sessionKey).toMatch(/^[0-9a-f]{16}$/);
		expect(parsed.jevCalled).toBe(true);
	});

	test("rotates once at the byte cap", async () => {
		await writeRaw(
			DRIFT_LOG_FILE,
			"x".repeat(MAX_DRIFT_LOG_BYTES + 10),
		);
		await appendDriftLog(root, logEntry());
		const rotated = await fs.readFile(
			path.join(root, DRIFT_LOG_ROTATED_FILE),
			"utf8",
		);
		expect(rotated.length).toBeGreaterThanOrEqual(MAX_DRIFT_LOG_BYTES);
		const fresh = await fs.readFile(path.join(root, DRIFT_LOG_FILE), "utf8");
		expect(fresh.trim().split("\n")).toHaveLength(1);
	});
});
