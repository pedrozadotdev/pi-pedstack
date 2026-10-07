// Compaction-guard store + policy resolution (plan Unit 3). In-memory episode
// state (AD-5), the live snapshot mirror for the handoff provider (AD-6), mode
// resolution, and the serialized shadow JSONL. Health precedence lives here;
// the pure tier→health mapping lives in facts.ts.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { sha256ShortHex } from "../utils/canonical-json";
import { MAX_LOG_BYTES, deriveHealth, deriveTier } from "./facts";
import type {
	CompactionAction,
	CompactionDimension,
	CompactionMode,
	CompactionOutcome,
	CompactionSessionState,
	CompactionSource,
	CompactionTier,
	ContextHealth,
} from "./types";

export const COMPACTION_LOG_FILE =
	".context/compound-engineering/compaction-guard.jsonl";
export const COMPACTION_LOG_ROTATED_FILE =
	".context/compound-engineering/compaction-guard.1.jsonl";

// ── In-memory session state (AD-5) ─────────────────────────────────

const sessions = new Map<string, CompactionSessionState>();
let currentSessionKey = "";
let currentMode: CompactionMode = "shadow";

/** The wiring records the resolved mode so degraded health logs are truthful. */
export function setCurrentCompactionMode(mode: CompactionMode): void {
	currentMode = mode;
}

export function setCurrentCompactionSessionKey(sessionKey: string): void {
	currentSessionKey = typeof sessionKey === "string" ? sessionKey : "";
}

export function getCurrentCompactionSessionKey(): string {
	return currentSessionKey;
}

/** The only accessor; every lifecycle path goes through it. */
export function getOrCreateSessionState(
	sessionKey: string,
): CompactionSessionState {
	let state = sessions.get(sessionKey);
	if (!state) {
		state = {
			consecutiveDefers: 0,
			lastSignature: null,
			lastOutcome: null,
			jevCalls: 0,
			lastCompactionAt: null,
			requestNotified: false,
		};
		sessions.set(sessionKey, state);
	}
	return state;
}

/** `session_compact`: keep the entry, reset the episode, stamp the compaction. */
export function resetEpisode(sessionKey: string, now: Date = new Date()): void {
	const state = getOrCreateSessionState(sessionKey);
	state.consecutiveDefers = 0;
	state.lastSignature = null;
	state.lastOutcome = null;
	state.jevCalls = 0;
	state.lastCompactionAt = now.toISOString();
	state.requestNotified = false;
}

/** `session_start` / `session_shutdown`: drop the entry entirely. */
export function resetSessionState(sessionKey: string): void {
	sessions.delete(sessionKey);
}

/** Test/teardown helper: the map returns to zero. */
export function resetAllSessionState(): void {
	sessions.clear();
}

export function sessionStateSize(): number {
	return sessions.size;
}

// ── Live snapshot mirror + health precedence (AD-6) ────────────────

export interface ContextSnapshot {
	tokens: number | null;
	contextWindow: number;
	capturedAt: string;
}

export interface ContextHealthReading {
	health: ContextHealth;
	degradedReason?: string;
}

let currentSnapshot: ContextSnapshot | null = null;

function toFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Capture the per-turn usage; an invalid window keeps the previous snapshot. */
export function captureContextSnapshot(input: {
	tokens?: unknown;
	contextWindow?: unknown;
	now?: Date;
}): void {
	const contextWindow = toFiniteNumber(input.contextWindow);
	if (contextWindow === null || contextWindow <= 0) return;
	const tokens = toFiniteNumber(input.tokens);
	const now = input.now ?? new Date();
	currentSnapshot = {
		tokens,
		contextWindow,
		capturedAt: now.toISOString(),
	};
}

export function getCurrentContextSnapshot(): ContextSnapshot | null {
	return currentSnapshot;
}

export function clearContextSnapshot(): void {
	currentSnapshot = null;
}

function compactionSince(snapshot: ContextSnapshot): boolean {
	if (!currentSessionKey) return false;
	const state = sessions.get(currentSessionKey);
	if (!state?.lastCompactionAt) return false;
	const compactedAt = Date.parse(state.lastCompactionAt);
	const capturedAt = Date.parse(snapshot.capturedAt);
	if (Number.isNaN(compactedAt) || Number.isNaN(capturedAt)) return false;
	return compactedAt >= capturedAt;
}

/**
 * Health precedence (AD-6): no snapshot → `watch`; a null token after a
 * compaction → `good`; an unexplained null → `watch` plus a degraded reason;
 * numeric tokens → the pure tier→health bridge. Never derived from Jev.
 */
export function getCurrentContextHealth(): ContextHealthReading {
	const snapshot = currentSnapshot;
	if (!snapshot) return { health: "watch" };
	if (snapshot.tokens === null) {
		if (compactionSince(snapshot)) return { health: "good" };
		return {
			health: "watch",
			degradedReason:
				"context tokens unavailable and no recent compaction to explain them",
		};
	}
	return {
		health: deriveHealth(deriveTier(snapshot.tokens / snapshot.contextWindow)),
	};
}

// ── Shadow log ─────────────────────────────────────────────────────

/** One redacted shadow-log line; every short-circuit outcome has a reason. */
export interface CompactionLogRecord {
	ts: string;
	mode: CompactionMode;
	sessionKey: string;
	reason: string;
	action: CompactionAction;
	source: CompactionSource;
	tier: CompactionTier;
	overageTokens: number | null;
	pressure: number | null;
	dimensions: CompactionDimension[];
	jevCalled: boolean;
	reused?: boolean;
	consecutiveDefers?: number;
	outcome?: CompactionOutcome;
}

// ponytail: one serialized chain; the guard logs at most one record per episode.
let chain: Promise<void> = Promise.resolve();

async function writeLog(
	repoRoot: string,
	record: CompactionLogRecord,
): Promise<void> {
	const file = path.join(repoRoot, COMPACTION_LOG_FILE);
	const rotated = path.join(repoRoot, COMPACTION_LOG_ROTATED_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		size = 0;
	}
	if (size >= MAX_LOG_BYTES) await rename(file, rotated);
	const redacted: CompactionLogRecord = {
		...record,
		sessionKey: sha256ShortHex(record.sessionKey),
	};
	await appendFile(file, `${JSON.stringify(redacted)}\n`, "utf8");
}

/** Append one shadow record, rotating once at the byte cap. Never rejects. */
export function appendCompactionLog(
	repoRoot: string,
	record: CompactionLogRecord,
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

/**
 * Row 4 of the health precedence (AD-6): a null token with no recent compaction
 * is recorded as a degraded telemetry entry. Never rejects.
 */
export function appendHealthDegradedLog(
	repoRoot: string,
	reason: string,
	now: Date = new Date(),
): Promise<void> {
	const outcome: CompactionOutcome = {
		action: "allow",
		source: "degraded",
		dimensions: [],
		reason,
	};
	return appendCompactionLog(repoRoot, {
		ts: now.toISOString(),
		mode: currentMode,
		sessionKey: currentSessionKey || "unknown-session",
		reason: "handoff-health",
		action: "allow",
		source: "degraded",
		tier: "silent",
		overageTokens: null,
		pressure: null,
		dimensions: [],
		jevCalled: false,
		outcome,
	});
}
