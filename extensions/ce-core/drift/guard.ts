// Drift guard orchestration (plan Unit 4): deterministic pre-pass → dedupe →
// cap → one bounded Jev call → derive → persist. All I/O is injected so tests
// never touch a live Jev.
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { JevRuntime } from "../jev/types";
import { getStageDiscipline, type StageDiscipline } from "../utils/stage-policy";
import {
	DRIFT_JEV_TIMEOUT_MS,
	MAX_DRIFT_JEV_CALLS_PER_SESSION,
	THRESHOLDS_VERSION,
	buildDriftRequest,
	correctionMessage,
	deriveVerdict,
	enforceRequestBodyLimit,
	hashTurnSignature,
	readAnswers,
} from "./combine";
import {
	appendDriftLog,
	clearDriftRecord,
	isDriftRecordFresh,
	readDriftRecord,
	writeDriftRecord,
	writeDriftStatus,
	type DriftLogRecord,
	type DriftRecord,
	type DriftStatus,
} from "./store";
import { buildTurnState, type BuildTurnStateInput } from "./turn-state";
import type {
	CorrectionDimensionId,
	DerivedVerdict,
	DriftDimension,
	DriftDimensionId,
	DriftMode,
	DriftOutcome,
	DriftSource,
	DriftTurnState,
	DriftVerdict,
} from "./types";

export interface DriftGuardInput {
	repoRoot: string;
	stage: string | null;
	message: TurnEndEvent["message"];
	toolResults: TurnEndEvent["toolResults"];
	turnIndex?: number;
}

export interface DriftGuardDeps {
	mode: DriftMode;
	/** Reserved for read-site parity; the turn side never blocks on outage. */
	failClosed: boolean;
	sessionKey: () => string;
	createJev: () => JevRuntime;
	now?: () => Date;
	readRecord?: (
		repoRoot: string,
		stage: string,
	) => Promise<DriftRecord | null>;
	writeRecord?: (
		repoRoot: string,
		record: DriftRecord,
	) => Promise<string> | string;
	clearRecord?: (repoRoot: string, stage: string) => Promise<void> | void;
	/**
	 * Per-stage last-evaluation health marker (D2). Written only in `enforce`
	 * for `jev`/`degraded` outcomes; defaults to the shared store writer.
	 */
	writeStatus?: (
		repoRoot: string,
		status: DriftStatus,
	) => Promise<void> | void;
	logRecord?: (repoRoot: string, record: DriftLogRecord) => void | Promise<void>;
	getStage?: (stage: string) => StageDiscipline | null;
	getTurnState?: (input: BuildTurnStateInput) => DriftTurnState | null;
}

export interface DriftGuardResult {
	ignored?: boolean;
	gated: boolean;
	verdict: DriftVerdict;
	source: DriftSource;
	dimensions: DriftDimension[];
	triggered: DriftDimensionId[];
	correction?: string;
	recorded: boolean;
	reason?: string;
}

export interface DriftGuard {
	evaluate(input: DriftGuardInput): Promise<DriftGuardResult>;
	/** One-shot pending correction (newest overwrites); clears on read. */
	getAndClearCorrection(): string | undefined;
	reset(): void;
}

interface GuardState {
	lastSignature: string | null;
	lastSessionKey: string;
	lastOutcome: DriftOutcome | null;
	jevCalls: number;
	pendingCorrection: string | null;
}

function ignoredResult(): DriftGuardResult {
	return {
		ignored: true,
		gated: false,
		verdict: "no_drift",
		source: "deterministic",
		dimensions: [],
		triggered: [],
		recorded: false,
	};
}

function outcomeToResult(
	outcome: DriftOutcome,
	extra: { gated: boolean; recorded: boolean },
): DriftGuardResult {
	return {
		gated: extra.gated,
		verdict: outcome.verdict,
		source: outcome.source,
		dimensions: outcome.dimensions,
		triggered: outcome.triggered,
		recorded: extra.recorded,
		...(outcome.correction ? { correction: outcome.correction } : {}),
		...(outcome.reason ? { reason: outcome.reason } : {}),
	};
}

/** One-shot correction copy for a mild verdict (first soft trigger). */
function correctionFor(
	triggered: DriftDimensionId[],
	stage: string,
): string | undefined {
	// A mild verdict has exactly one soft signal (VD-3), and `progress` is
	// never in `triggered` (FT-5), so the first trigger is always correctable.
	const dimension = triggered[0] as CorrectionDimensionId | undefined;
	return dimension ? correctionMessage(dimension, stage) : undefined;
}

function degradedOutcome(reason: string): DriftOutcome {
	return {
		verdict: "no_drift",
		source: "degraded",
		dimensions: [],
		triggered: [],
		reason,
	};
}

function deterministicOutcome(reason: string): DriftOutcome {
	return {
		verdict: "no_drift",
		source: "deterministic",
		dimensions: [],
		triggered: [],
		reason,
	};
}

function buildLogRecord(
	stage: string,
	sessionKey: string,
	mode: DriftMode,
	signature: string,
	outcome: DriftOutcome,
	jevCalled: boolean,
	statusWriteFailed: boolean,
	now: Date,
): DriftLogRecord {
	return {
		ts: now.toISOString(),
		stage,
		sessionKey,
		mode,
		source: outcome.source,
		verdict: outcome.verdict,
		signature,
		triggered: outcome.triggered,
		dimensions: outcome.dimensions.map((entry) => ({
			id: entry.id,
			value: entry.value,
			confidence: entry.confidence,
		})),
		jevCalled,
		...(statusWriteFailed ? { statusWriteFailed: true } : {}),
		...(outcome.reason ? { reason: outcome.reason } : {}),
		...(outcome.correction ? { correction: outcome.correction } : {}),
	};
}

async function logOutcome(
	repoRoot: string,
	deps: DriftGuardDeps,
	record: DriftLogRecord,
): Promise<void> {
	try {
		if (deps.logRecord) await deps.logRecord(repoRoot, record);
		else await appendDriftLog(repoRoot, record);
	} catch {
		// ponytail: swallowed — the sink is best-effort telemetry.
	}
}

/** Best-effort status marker write; never fails the turn (D2). */
async function writeStatusSafe(
	repoRoot: string,
	deps: DriftGuardDeps,
	status: DriftStatus,
): Promise<boolean> {
	try {
		if (deps.writeStatus) await deps.writeStatus(repoRoot, status);
		else await writeDriftStatus(repoRoot, status);
		return true;
	} catch {
		// ponytail: swallowed — the marker is best-effort; the log carries the failure.
		return false;
	}
}

async function persistOutcome(
	repoRoot: string,
	deps: DriftGuardDeps,
	stage: string,
	sessionKey: string,
	turnIndex: number,
	signature: string,
	outcome: DriftOutcome,
	counters: { consecutiveMild: number; consecutiveNoDrift: number },
	priorFresh: boolean,
	prior: DriftRecord | null,
	now: Date,
): Promise<boolean> {
	if (deps.mode !== "enforce" || outcome.source !== "jev") return false;

	const clearedStrong =
		outcome.verdict === "no_drift" &&
		priorFresh &&
		prior?.verdict === "strong_drift";

	try {
		if (clearedStrong) {
			if (deps.clearRecord) await deps.clearRecord(repoRoot, stage);
			else await clearDriftRecord(repoRoot, stage);
			return false;
		}
		const record: DriftRecord = {
			schema: 1,
			stage,
			sessionKey,
			turnIndex,
			signature,
			thresholdsVersion: THRESHOLDS_VERSION,
			verdict: outcome.verdict,
			source: outcome.source,
			triggered: outcome.triggered,
			...(outcome.correction ? { correction: outcome.correction } : {}),
			...(outcome.reason ? { reason: outcome.reason } : {}),
			consecutiveMild: counters.consecutiveMild,
			consecutiveNoDrift: counters.consecutiveNoDrift,
			updatedAt: now.toISOString(),
		};
		if (deps.writeRecord) await deps.writeRecord(repoRoot, record);
		else await writeDriftRecord(repoRoot, record);
		return true;
	} catch {
		// ponytail: swallowed — the verdict is already decided.
		return false;
	}
}

/** Deterministic short-circuit: log only, never write a record. */
async function finishDeterministic(
	input: DriftGuardInput,
	deps: DriftGuardDeps,
	stage: string,
	sessionKey: string,
	signature: string,
	reason: string,
	now: Date,
): Promise<DriftGuardResult> {
	const outcome = deterministicOutcome(reason);
	await logOutcome(
		input.repoRoot,
		deps,
		buildLogRecord(stage, sessionKey, deps.mode, signature, outcome, false, false, now),
	);
	return outcomeToResult(outcome, { gated: true, recorded: false });
}

interface JudgementContext {
	stage: string;
	sessionKey: string;
	signature: string;
	turnState: DriftTurnState;
	now: Date;
}

/** The unchanged-signature reuse outcome, or `null` when the turn is new. */
function reuseUnchangedTurn(
	state: GuardState,
	sessionKey: string,
	signature: string,
): DriftOutcome | null {
	if (
		state.lastSignature !== signature ||
		state.lastSessionKey !== sessionKey ||
		!state.lastOutcome
	) {
		return null;
	}
	return {
		...state.lastOutcome,
		source: "deterministic",
		reason: "unchanged turn",
	};
}

/** Combine validated answers with the prior record into a jev outcome. */
function deriveJevOutcome(
	answers: DriftDimension[],
	context: JudgementContext,
	prior: DriftRecord | null,
	priorFresh: boolean,
	deps: DriftGuardDeps,
): { outcome: DriftOutcome; derived: DerivedVerdict } {
	const derived = deriveVerdict(answers, {
		priorConsecutiveMild: priorFresh ? prior?.consecutiveMild ?? 0 : 0,
		priorVerdict: priorFresh ? prior?.verdict : undefined,
		priorConsecutiveNoDrift: priorFresh ? prior?.consecutiveNoDrift ?? 0 : 0,
		wroteStageArtifact: context.turnState.wroteStageArtifact,
	});
	const correction =
		derived.verdict === "mild_drift" && deps.mode === "enforce"
			? correctionFor(derived.triggered, context.stage)
			: undefined;
	return {
		derived,
		outcome: {
			verdict: derived.verdict,
			source: "jev",
			dimensions: answers,
			triggered: derived.triggered,
			...(correction ? { correction } : {}),
		},
	};
}

/** One bounded Jev call → validated answers → derived verdict + persist. */
async function computeJevOutcome(
	input: DriftGuardInput,
	deps: DriftGuardDeps,
	state: GuardState,
	context: JudgementContext,
): Promise<{ outcome: DriftOutcome; recorded: boolean }> {
	const readRecord = deps.readRecord ?? readDriftRecord;
	try {
		const prior = await readRecord(input.repoRoot, context.stage);
		const priorFresh = isDriftRecordFresh(
			prior,
			context.stage,
			context.sessionKey,
			context.now,
		);
		state.jevCalls += 1;
		const request = buildDriftRequest(context.turnState);
		enforceRequestBodyLimit(request);
		const result = await deps.createJev().decide(request, {
			timeoutMs: DRIFT_JEV_TIMEOUT_MS,
		});
		const answers = readAnswers(result);
		if (typeof answers === "string") {
			return { outcome: degradedOutcome(answers), recorded: false };
		}

		const { outcome, derived } = deriveJevOutcome(
			answers,
			context,
			prior,
			priorFresh,
			deps,
		);
		state.lastSignature = context.signature;
		state.lastSessionKey = context.sessionKey;
		state.lastOutcome = outcome;
		const recorded = await persistOutcome(
			input.repoRoot,
			deps,
			context.stage,
			context.sessionKey,
			input.turnIndex ?? 0,
			context.signature,
			outcome,
			{
				consecutiveMild: derived.consecutiveMild,
				consecutiveNoDrift: derived.consecutiveNoDrift,
			},
			priorFresh,
			prior,
			context.now,
		);
		return { outcome, recorded };
	} catch (error) {
		return {
			outcome: degradedOutcome(
				error instanceof Error ? error.message : String(error),
			),
			recorded: false,
		};
	}
}

/** Jev path: compute, store the one-shot correction, and log. */
async function runJevJudgment(
	input: DriftGuardInput,
	deps: DriftGuardDeps,
	state: GuardState,
	context: JudgementContext,
): Promise<DriftGuardResult> {
	const { outcome, recorded } = await computeJevOutcome(
		input,
		deps,
		state,
		context,
	);
	let statusWriteFailed = false;
	if (
		deps.mode === "enforce" &&
		(outcome.source === "jev" || outcome.source === "degraded")
	) {
		statusWriteFailed = !(await writeStatusSafe(input.repoRoot, deps, {
			schema: 1,
			stage: context.stage,
			sessionKey: context.sessionKey,
			thresholdsVersion: THRESHOLDS_VERSION,
			degraded: outcome.source === "degraded",
			updatedAt: context.now.toISOString(),
		}));
	}
	if (
		deps.mode === "enforce" &&
		outcome.source === "jev" &&
		outcome.verdict === "mild_drift" &&
		outcome.correction
	) {
		state.pendingCorrection = outcome.correction;
	}
	await logOutcome(
		input.repoRoot,
		deps,
		buildLogRecord(
			context.stage,
			context.sessionKey,
			deps.mode,
			context.signature,
			outcome,
			outcome.source === "jev" || outcome.source === "degraded",
			statusWriteFailed,
			context.now,
		),
	);
	return outcomeToResult(outcome, { gated: true, recorded });
}

type TurnResolution =
	| { kind: "unknown" }
	| { kind: "trivial" }
	| { kind: "ok"; turnState: DriftTurnState };

/** Resolve discipline + the compact turn state without throwing. */
function resolveTurnState(
	input: DriftGuardInput,
	deps: DriftGuardDeps,
	stage: string,
): TurnResolution {
	const discipline = stage
		? (deps.getStage ?? getStageDiscipline)(stage)
		: null;
	if (!discipline) return { kind: "unknown" };
	const turnState = (deps.getTurnState ?? buildTurnState)({
		repoRoot: input.repoRoot,
		stage,
		discipline,
		message: input.message,
		toolResults: input.toolResults,
	});
	return turnState ? { kind: "ok", turnState } : { kind: "trivial" };
}

async function evaluateDrift(
	input: DriftGuardInput,
	deps: DriftGuardDeps,
	state: GuardState,
): Promise<DriftGuardResult> {
	if (deps.mode === "off") return ignoredResult();

	const now = (deps.now ?? (() => new Date()))();
	const sessionKey = deps.sessionKey();
	const stage = input.stage ?? "";

	const resolved = resolveTurnState(input, deps, stage);
	if (resolved.kind !== "ok") {
		return finishDeterministic(
			input,
			deps,
			stage,
			sessionKey,
			"",
			resolved.kind === "unknown" ? "unknown stage" : "trivial turn",
			now,
		);
	}

	const signature = hashTurnSignature(resolved.turnState);
	const reused = reuseUnchangedTurn(state, sessionKey, signature);
	if (reused) {
		await logOutcome(
			input.repoRoot,
			deps,
			buildLogRecord(
				stage,
				sessionKey,
				deps.mode,
				signature,
				reused,
				false,
				false,
				now,
			),
		);
		return outcomeToResult(reused, { gated: true, recorded: false });
	}

	if (state.jevCalls >= MAX_DRIFT_JEV_CALLS_PER_SESSION) {
		return finishDeterministic(
			input,
			deps,
			stage,
			sessionKey,
			signature,
			"per-session Jev call cap reached",
			now,
		);
	}

	return runJevJudgment(input, deps, state, {
		stage,
		sessionKey,
		signature,
		turnState: resolved.turnState,
		now,
	});
}

/** @internal exported for tests; build a guard with injected I/O. */
export function createDriftGuard(deps: DriftGuardDeps): DriftGuard {
	const state: GuardState = {
		lastSignature: null,
		lastSessionKey: "",
		lastOutcome: null,
		jevCalls: 0,
		pendingCorrection: null,
	};

	return {
		evaluate: (input: DriftGuardInput) =>
			evaluateDrift(input, deps, state).catch(() =>
				outcomeToResult(deterministicOutcome("guard failed open"), {
					gated: true,
					recorded: false,
				}),
			),
		getAndClearCorrection(): string | undefined {
			const pending = state.pendingCorrection;
			state.pendingCorrection = null;
			return pending ?? undefined;
		},
		reset(): void {
			state.lastSignature = null;
			state.lastSessionKey = "";
			state.lastOutcome = null;
			state.jevCalls = 0;
			state.pendingCorrection = null;
		},
	};
}
