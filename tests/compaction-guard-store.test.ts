// Unit 3 — compaction-guard store: mode/live resolution, in-memory session
// state, the live snapshot mirror + health precedence, and the shadow log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	MAX_CONSECUTIVE_DEFERS,
	MAX_LOG_BYTES,
} from "../extensions/ce-core/compaction-guard/facts.js";
import {
	COMPACTION_LOG_FILE,
	COMPACTION_LOG_ROTATED_FILE,
	appendCompactionLog,
	captureContextSnapshot,
	clearContextSnapshot,
	getCurrentCompactionSessionKey,
	getCurrentContextHealth,
	getCurrentContextSnapshot,
	getOrCreateSessionState,
	resetAllSessionState,
	resetEpisode,
	resetSessionState,
	resolveCompactionLive,
	resolveCompactionMode,
	sessionStateSize,
	setCurrentCompactionSessionKey,
	type CompactionLogRecord,
} from "../extensions/ce-core/compaction-guard/store.js";

let root: string;

async function writeRaw(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
}

function entry(): CompactionLogRecord {
	return {
		ts: "2026-10-06T00:00:00.000Z",
		mode: "shadow",
		sessionKey: "sid-1",
		reason: "threshold",
		action: "allow",
		source: "deterministic",
		tier: "recommend",
		overageTokens: 384,
		pressure: 0.875,
		dimensions: [],
		jevCalled: false,
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-store-"));
	resetAllSessionState();
	clearContextSnapshot();
	setCurrentCompactionSessionKey("");
});

afterEach(async () => {
	resetAllSessionState();
	clearContextSnapshot();
	setCurrentCompactionSessionKey("");
	await fs.rm(root, { recursive: true, force: true });
});

describe("mode and live resolution", () => {
	test("resolves mode, defaulting missing/invalid to shadow", () => {
		expect(resolveCompactionMode({})).toBe("shadow");
		expect(resolveCompactionMode({ PEDSTACK_COMPACTION_GUARD: "" })).toBe(
			"shadow",
		);
		expect(resolveCompactionMode({ PEDSTACK_COMPACTION_GUARD: "wat" })).toBe(
			"shadow",
		);
		expect(resolveCompactionMode({ PEDSTACK_COMPACTION_GUARD: "off" })).toBe(
			"off",
		);
		expect(
			resolveCompactionMode({ PEDSTACK_COMPACTION_GUARD: "enforce" }),
		).toBe("enforce");
	});

	test("resolves live only for the literal 1", () => {
		expect(resolveCompactionLive({})).toBe(false);
		expect(resolveCompactionLive({ PEDSTACK_COMPACTION_GUARD_LIVE: "true" })).toBe(
			false,
		);
		expect(resolveCompactionLive({ PEDSTACK_COMPACTION_GUARD_LIVE: "1" })).toBe(
			true,
		);
	});
});

describe("in-memory session state", () => {
	test("getOrCreate is stable per key and isolated across sessions", () => {
		const a = getOrCreateSessionState("a");
		expect(getOrCreateSessionState("a")).toBe(a);
		expect(getOrCreateSessionState("b")).not.toBe(a);
		expect(sessionStateSize()).toBe(2);
	});

	test("resetEpisode resets counters and stamps the compaction time", () => {
		const now = new Date("2026-10-06T01:00:00.000Z");
		const state = getOrCreateSessionState("a");
		state.consecutiveDefers = MAX_CONSECUTIVE_DEFERS;
		state.lastSignature = "sig";
		state.jevCalls = 5;
		state.lastOutcome = {
			action: "defer",
			source: "jev",
			dimensions: [],
		};
		resetEpisode("a", now);
		expect(state.consecutiveDefers).toBe(0);
		expect(state.lastSignature).toBeNull();
		expect(state.lastOutcome).toBeNull();
		expect(state.jevCalls).toBe(0);
		expect(state.lastCompactionAt).toBe(now.toISOString());
	});

	test("resetSessionState deletes the entry; the map returns to zero", () => {
		getOrCreateSessionState("leak");
		getOrCreateSessionState("other");
		resetSessionState("leak");
		resetSessionState("other");
		expect(sessionStateSize()).toBe(0);
	});

	test("mirrors the current session key at module level", () => {
		setCurrentCompactionSessionKey("abc");
		expect(getCurrentCompactionSessionKey()).toBe("abc");
	});
});

describe("snapshot mirror and health precedence", () => {
	test("no snapshot keeps the watch default", () => {
		expect(getCurrentContextSnapshot()).toBeNull();
		expect(getCurrentContextHealth()).toEqual({ health: "watch" });
	});

	test("maps numeric pressure through tier → health", () => {
		const cases: Array<[number, string]> = [
			[0.1, "good"],
			[0.65, "watch"],
			[0.8, "heavy"],
			[0.95, "critical"],
		];
		for (const [pressure, health] of cases) {
			captureContextSnapshot({
				tokens: pressure * 100_000,
				contextWindow: 100_000,
			});
			expect(getCurrentContextHealth().health).toBe(health);
		}
	});

	test("a null token read after a compaction is good", () => {
		setCurrentCompactionSessionKey("sid");
		captureContextSnapshot({ tokens: null, contextWindow: 100_000, now: new Date("2026-10-06T00:00:00.000Z") });
		resetEpisode("sid", new Date("2026-10-06T00:00:01.000Z"));
		expect(getCurrentContextHealth()).toEqual({ health: "good" });
	});

	test("a null token read with no recent compaction is watch plus degraded", () => {
		setCurrentCompactionSessionKey("sid");
		captureContextSnapshot({ tokens: null, contextWindow: 100_000 });
		const result = getCurrentContextHealth();
		expect(result.health).toBe("watch");
		expect(result.degradedReason).toBeDefined();
	});

	test("keeps the last snapshot when the new window is invalid", () => {
		captureContextSnapshot({ tokens: 65_000, contextWindow: 100_000 });
		captureContextSnapshot({ tokens: 10, contextWindow: Number.NaN });
		expect(getCurrentContextSnapshot()?.contextWindow).toBe(100_000);
	});

	test("clear removes the snapshot", () => {
		captureContextSnapshot({ tokens: 1, contextWindow: 100 });
		clearContextSnapshot();
		expect(getCurrentContextSnapshot()).toBeNull();
	});
});

describe("shadow log", () => {
	test("writes one JSON line with a hashed session key", async () => {
		await appendCompactionLog(root, entry());
		const content = await fs.readFile(path.join(root, COMPACTION_LOG_FILE), "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.action).toBe("allow");
		expect(parsed.tier).toBe("recommend");
		expect(parsed.sessionKey).toMatch(/^[0-9a-f]{16}$/);
	});

	test("rotates once at the byte cap", async () => {
		await writeRaw(COMPACTION_LOG_FILE, "x".repeat(MAX_LOG_BYTES + 10));
		await appendCompactionLog(root, entry());
		const rotated = await fs.readFile(
			path.join(root, COMPACTION_LOG_ROTATED_FILE),
			"utf8",
		);
		expect(rotated.length).toBeGreaterThanOrEqual(MAX_LOG_BYTES);
		const fresh = await fs.readFile(path.join(root, COMPACTION_LOG_FILE), "utf8");
		expect(fresh.trim().split("\n")).toHaveLength(1);
	});

	test("appends to an absent log without throwing", async () => {
		await expect(appendCompactionLog(root, entry())).resolves.toBeUndefined();
	});
});
