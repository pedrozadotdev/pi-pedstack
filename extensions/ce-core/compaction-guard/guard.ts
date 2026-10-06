// Compaction-guard orchestration (plan Unit 4): deterministic short-circuits →
// signature reuse → session cap → one bounded Jev call → re-applied hard guards
// → enforce-agnostic defer. All I/O is injected so tests never touch a live Jev.
import type { JevRuntime } from "../jev/types";
import {
	ENFORCE_JEV_TIMEOUT_MS,
	MAX_CONSECUTIVE_DEFERS,
	MAX_JEV_CALLS_PER_SESSION,
	NOTICE_FLOOR,
	OVERAGE_TOKENS,
	SHADOW_JEV_TIMEOUT_MS,
	computeFacts,
} from "./facts";
import {
	buildCompactionRequest,
	buildCompactionState,
	deriveOutcome,
	enforceRequestBodyLimit,
	hashCompactionSignature,
	readAnswers,
} from "./combine";
import {
	appendCompactionLog,
	getOrCreateSessionState,
	type CompactionLogRecord,
} from "./store";
import type {
	CompactionAction,
	CompactionDimension,
	CompactionFacts,
	CompactionMode,
	CompactionOutcome,
	CompactionSessionState,
	CompactionSource,
	CompactionState,
	CompactionTier,
} from "./types";

export interface CompactionGuardInput {
	repoRoot: string;
	reason?: unknown;
	willRetry?: unknown;
	tokensBefore?: unknown;
	contextWindow?: unknown;
	reserveTokens?: unknown;
	isSplitTurn?: unknown;
	recentEntries?: unknown;
	priorSummary?: unknown;
	now?: Date;
}

export interface CompactionGuardDeps {
	mode: CompactionMode;
	/** Whether `shadow` may make a live Jev call (AD-2). */
	live: boolean;
	sessionKey: () => string;
	createJev: () => JevRuntime;
	now?: () => Date;
	logRecord?: (
		repoRoot: string,
		record: CompactionLogRecord,
	) => void | Promise<void>;
}

export interface CompactionGuardResult {
	ignored?: boolean;
	gated: boolean;
	action: CompactionAction;
	source: CompactionSource;
	dimensions: CompactionDimension[];
	reused: boolean;
	jevCalled: boolean;
	tier: CompactionTier;
	overageTokens: number | null;
	pressure: number | null;
	reason?: string;
}

export interface CompactionGuard {
	evaluate(input: CompactionGuardInput): Promise<CompactionGuardResult>;
}

/** The five deterministic hard guards that must all pass before any defer. */
function firstBlockingGuard(
	input: CompactionGuardInput,
	facts: CompactionFacts,
	state: CompactionSessionState,
): string | null {
	if (facts.reason !== "threshold") {
		return `not a threshold compaction (${facts.reason})`;
	}
	if (input.willRetry === true) return "overflow retry";
	if (facts.contextWindow === null || facts.triggerTokens === null) {
		return "unknown context window";
	}
	if (facts.overageTokens === null) return "unknown overage";
	if (facts.overageTokens < 0 || facts.overageTokens > OVERAGE_TOKENS) {
		return `overage ${facts.overageTokens} outside [0, ${OVERAGE_TOKENS}]`;
	}
	if (state.consecutiveDefers >= MAX_CONSECUTIVE_DEFERS) {
		return "defer budget exhausted";
	}
	if (facts.pressure === null || facts.pressure < NOTICE_FLOOR) {
		return "pressure below the notice floor";
	}
	return null;
}

function deterministicAllow(
	reason: string,
	dimensions: CompactionDimension[] = [],
): CompactionOutcome {
	return { action: "allow", source: "deterministic", dimensions, reason };
}

function degradedAllow(reason: string): CompactionOutcome {
	return { action: "allow", source: "degraded", dimensions: [], reason };
}

/** The unchanged-signature reuse, or `null` when there is no fresh jev cache. */
function reuseOutcome(
	state: CompactionSessionState,
	signature: string,
): CompactionOutcome | null {
	if (
		state.lastSignature !== signature ||
		!state.lastOutcome ||
		state.lastOutcome.source !== "jev"
	) {
		return null;
	}
	return { ...state.lastOutcome, reused: true };
}

/** Cache only fresh jev outcomes; count every defer against the loop budget. */
function applyOutcome(
	state: CompactionSessionState,
	outcome: CompactionOutcome,
	signature: string,
): void {
	state.consecutiveDefers =
		outcome.action === "defer" ? state.consecutiveDefers + 1 : 0;
	if (outcome.source === "jev") {
		state.lastSignature = signature;
		state.lastOutcome = outcome;
	}
}

function makeLog(
	deps: CompactionGuardDeps,
	sessionKey: string,
	facts: CompactionFacts,
	outcome: CompactionOutcome,
	jevCalled: boolean,
	state: CompactionSessionState,
	now: Date,
): CompactionLogRecord {
	return {
		ts: now.toISOString(),
		mode: deps.mode,
		sessionKey,
		reason: facts.reason,
		action: outcome.action,
		source: outcome.source,
		tier: facts.tier,
		overageTokens: facts.overageTokens,
		pressure: facts.pressure,
		dimensions: outcome.dimensions,
		jevCalled,
		consecutiveDefers: state.consecutiveDefers,
		outcome,
		...(outcome.reused ? { reused: true } : {}),
	};
}

async function logOutcome(
	deps: CompactionGuardDeps,
	repoRoot: string,
	record: CompactionLogRecord,
): Promise<void> {
	try {
		if (deps.logRecord) await deps.logRecord(repoRoot, record);
		else await appendCompactionLog(repoRoot, record);
	} catch {
		// ponytail: swallowed — the sink is best-effort telemetry.
	}
}

function toResult(
	outcome: CompactionOutcome,
	facts: CompactionFacts,
	jevCalled: boolean,
	gated = true,
): CompactionGuardResult {
	return {
		gated,
		action: outcome.action,
		source: outcome.source,
		dimensions: outcome.dimensions,
		reused: outcome.reused === true,
		jevCalled,
		tier: facts.tier,
		overageTokens: facts.overageTokens,
		pressure: facts.pressure,
		...(outcome.reason ? { reason: outcome.reason } : {}),
	};
}

function ignoredResult(facts: CompactionFacts): CompactionGuardResult {
	return {
		...toResult(deterministicAllow("mode off"), facts, false, false),
		ignored: true,
	};
}

/** A deterministic short-circuit: log one outcome, return `allow`. */
async function finishDeterministic(
	deps: CompactionGuardDeps,
	input: CompactionGuardInput,
	sessionKey: string,
	facts: CompactionFacts,
	state: CompactionSessionState,
	reason: string,
	now: Date,
): Promise<CompactionGuardResult> {
	const outcome = deterministicAllow(reason);
	await logOutcome(
		deps,
		input.repoRoot,
		makeLog(deps, sessionKey, facts, outcome, false, state, now),
	);
	return toResult(outcome, facts, false);
}

/** Ordered pre-pass: blocking guard → reuse → cap → shadow gate. */
async function resolvePrePass(
	input: CompactionGuardInput,
	deps: CompactionGuardDeps,
	facts: CompactionFacts,
	state: CompactionSessionState,
	signature: string,
	sessionKey: string,
	now: Date,
): Promise<CompactionGuardResult | null> {
	const blocked = firstBlockingGuard(input, facts, state);
	if (blocked) {
		return finishDeterministic(
			deps,
			input,
			sessionKey,
			facts,
			state,
			blocked,
			now,
		);
	}

	const reused = reuseOutcome(state, signature);
	if (reused) {
		applyOutcome(state, reused, signature);
		await logOutcome(
			deps,
			input.repoRoot,
			makeLog(deps, sessionKey, facts, reused, false, state, now),
		);
		return toResult(reused, facts, false);
	}

	if (state.jevCalls >= MAX_JEV_CALLS_PER_SESSION) {
		return finishDeterministic(
			deps,
			input,
			sessionKey,
			facts,
			state,
			"per-session Jev call cap reached",
			now,
		);
	}

	if (deps.mode === "shadow" && !deps.live) {
		return finishDeterministic(
			deps,
			input,
			sessionKey,
			facts,
			state,
			"shadow is deterministic-only without LIVE",
			now,
		);
	}

	return null;
}

/** One bounded Jev call; never throws (an outage degrades to allow). */
async function freshJevOutcome(
	deps: CompactionGuardDeps,
	built: CompactionState,
): Promise<{ outcome: CompactionOutcome; called: boolean }> {
	try {
		const request = buildCompactionRequest(built);
		enforceRequestBodyLimit(request);
		const timeoutMs =
			deps.mode === "enforce"
				? ENFORCE_JEV_TIMEOUT_MS
				: SHADOW_JEV_TIMEOUT_MS;
		const result = await deps.createJev().decide(request, { timeoutMs });
		const answers = readAnswers(result);
		if (typeof answers === "string") {
			return { outcome: degradedAllow(answers), called: true };
		}
		return { outcome: deriveOutcome(answers), called: true };
	} catch (error) {
		return {
			outcome: degradedAllow(
				error instanceof Error ? error.message : String(error),
			),
			called: true,
		};
	}
}

/** Fresh Jev judgment: call, re-apply hard guards, apply, log, return. */
async function runFreshJev(
	input: CompactionGuardInput,
	deps: CompactionGuardDeps,
	facts: CompactionFacts,
	state: CompactionSessionState,
	signature: string,
	sessionKey: string,
	now: Date,
	built: CompactionState,
): Promise<CompactionGuardResult> {
	state.jevCalls += 1;
	const { outcome, called } = await freshJevOutcome(deps, built);
	let finalOutcome = outcome;
	if (outcome.source === "jev") {
		// Step 11: re-apply every hard guard to the derived action.
		const recheck = firstBlockingGuard(input, facts, state);
		if (recheck) finalOutcome = deterministicAllow(recheck, outcome.dimensions);
	}
	applyOutcome(state, finalOutcome, signature);
	await logOutcome(
		deps,
		input.repoRoot,
		makeLog(deps, sessionKey, facts, finalOutcome, called, state, now),
	);
	return toResult(finalOutcome, facts, called);
}

async function evaluateCompaction(
	input: CompactionGuardInput,
	deps: CompactionGuardDeps,
): Promise<CompactionGuardResult> {
	const facts = computeFacts({
		reason: input.reason,
		tokensBefore: input.tokensBefore,
		contextWindow: input.contextWindow,
		reserveTokens: input.reserveTokens,
	});
	if (deps.mode === "off") return ignoredResult(facts);

	const now = input.now ?? deps.now?.() ?? new Date();
	const sessionKey = deps.sessionKey();
	const state = getOrCreateSessionState(sessionKey);
	const built = buildCompactionState({
		facts,
		isSplitTurn: input.isSplitTurn,
		recentEntries: input.recentEntries,
		priorSummary: input.priorSummary,
	});
	const signature = hashCompactionSignature(built);

	const pre = await resolvePrePass(
		input,
		deps,
		facts,
		state,
		signature,
		sessionKey,
		now,
	);
	if (pre) return pre;
	return runFreshJev(
		input,
		deps,
		facts,
		state,
		signature,
		sessionKey,
		now,
		built,
	);
}

/** @internal exported for tests; build a guard with injected I/O. */
export function createCompactionGuard(deps: CompactionGuardDeps): CompactionGuard {
	return {
		evaluate: (input) =>
			evaluateCompaction(input, deps).catch((error) => {
				const facts = computeFacts({
					reason: input.reason,
					tokensBefore: input.tokensBefore,
					contextWindow: input.contextWindow,
					reserveTokens: input.reserveTokens,
				});
				return toResult(
					degradedAllow(
						error instanceof Error ? error.message : String(error),
					),
					facts,
					false,
				);
			}),
	};
}
