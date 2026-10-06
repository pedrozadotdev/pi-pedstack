/**
 * Orchestration for the Jev semantic stage guard on `bash` tool calls.
 *
 * No Pi imports: the Jev runtime, the shadow log sink, and the notifier are all
 * injected, so this module is unit-testable without the extension harness. The
 * deterministic plan is computed first; Jev is consulted only for `needsJev`
 * plans, serialized (one in-flight decision) and deduped per stage+repo+command.
 *
 * @module stage-guard-runtime
 */

import type { JevRuntime } from "../jev/types";
import { appendGuardLog } from "./guard-log";
import {
	applyJevAnswers,
	buildGuardRequest,
	DEDUPE_CACHE_MAX,
	GUARD_JEV_TIMEOUT_MS,
	planCommandGuard,
	type DeterministicPlan,
	type GuardLogRecord,
	type GuardMode,
	type GuardVerdict,
} from "./semantic-stage-guard";

export interface StageGuardInput {
	repoRoot: string;
	stage: string | null;
	cwd: string;
	command: string;
	notify?: (message: string) => void;
}

export interface StageGuardResult {
	block?: boolean;
	reason?: string;
}

export interface StageGuardOptions {
	mode: GuardMode;
	failClosed: boolean;
	createJev: () => JevRuntime;
	now?: () => Date;
	logRecord?: (repoRoot: string, record: GuardLogRecord) => Promise<void>;
}

export interface StageGuard {
	evaluate(input: StageGuardInput): Promise<StageGuardResult | undefined>;
	/** Drop memoized runtime + dedupe state (test/reset seam). */
	reset(): void;
}

const DEGRADED_NOTICE =
	"Pedstack Jev stage guard degraded: semantic decisions are unavailable, so " +
	"ambiguous commands fail open. Set PEDSTACK_JEV_STAGE_GUARD_FAILCLOSED=1 with " +
	"enforce mode to block instead.";

function degradedBlockReason(stage: string | null): string {
	const label = stage ? `stage "${stage}"` : "the current stage";
	return (
		`Pedstack stage guard blocked this bash command: ${label} and the Jev ` +
		`semantic decision layer is unavailable (FAILCLOSED=1). ` +
		`Set PEDSTACK_DISABLE_GUARD=1 to bypass.`
	);
}

function toRecord(
	verdict: GuardVerdict,
	stage: string | null,
	mode: GuardMode,
	now: () => Date,
): GuardLogRecord {
	return {
		ts: now().toISOString(),
		stage,
		toolName: "bash",
		effectSource: verdict.effectSource,
		effect: verdict.effect,
		intent: verdict.intent,
		jevConfidence: verdict.jevConfidence,
		deterministicTargets: verdict.targets.map((target) => ({
			path: target.path,
			class: target.pathClass,
			allow: target.allow,
		})),
		verdict: verdict.verdict,
		mode,
		fallbackReason: verdict.fallbackReason,
	};
}

export function createStageGuard(options: StageGuardOptions): StageGuard {
	const now = options.now ?? ((): Date => new Date());
	const logRecord = options.logRecord ?? appendGuardLog;
	const dedupe = new Map<string, Promise<GuardVerdict>>();
	let jev: JevRuntime | null = null;
	let jevChain: Promise<void> = Promise.resolve();
	let degradedNotified = false;

	function notice(input: StageGuardInput, message: string): void {
		if (degradedNotified) return;
		degradedNotified = true;
		input.notify?.(message);
	}

	function getJev(): JevRuntime {
		if (!jev) jev = options.createJev();
		return jev;
	}

	function fallback(
		input: StageGuardInput,
		plan: DeterministicPlan,
		reason: string,
	): GuardVerdict {
		const base: GuardVerdict = {
			verdict: "allow",
			effect: plan.effect,
			effectSource: "fallback",
			targets: plan.targets,
			fallbackReason: reason,
		};
		if (options.failClosed && options.mode === "enforce") {
			return {
				...base,
				verdict: "block",
				reason: degradedBlockReason(input.stage),
			};
		}
		return base;
	}

	async function runJev(
		input: StageGuardInput,
		plan: DeterministicPlan,
	): Promise<GuardVerdict> {
		try {
			const request = buildGuardRequest(input.stage, input.command, plan);
			const result = await getJev().decide(request, {
				timeoutMs: GUARD_JEV_TIMEOUT_MS,
				cwd: input.cwd,
			});
			return applyJevAnswers(input.stage, input.repoRoot, plan, result);
		} catch (error) {
			return fallback(
				input,
				plan,
				error instanceof Error ? error.message : "Jev unavailable",
			);
		}
	}

	/** Dedupe by stage+repo+command and serialize decisions through one chain. */
	function decide(
		input: StageGuardInput,
		plan: DeterministicPlan,
	): Promise<GuardVerdict> {
		const key = `${input.stage}\u0000${input.repoRoot}\u0000${input.command}`;
		const cached = dedupe.get(key);
		if (cached) return cached;

		const run = jevChain.then(() => runJev(input, plan));
		jevChain = run.then(
			() => undefined,
			() => undefined,
		);
		dedupe.set(key, run);
		if (dedupe.size > DEDUPE_CACHE_MAX) {
			const oldest = dedupe.keys().next().value;
			if (oldest !== undefined) dedupe.delete(oldest);
		}
		return run;
	}

	async function logVerdict(
		input: StageGuardInput,
		verdict: GuardVerdict,
	): Promise<void> {
		try {
			await logRecord(
				input.repoRoot,
				toRecord(verdict, input.stage, options.mode, now),
			);
		} catch {
			// ponytail: the shadow sink is best-effort telemetry only.
		}
	}

	return {
		async evaluate(input) {
			if (options.mode === "off") return undefined;

			const plan = planCommandGuard(input.stage, input.repoRoot, input.command);
			const verdict = plan.verdict ?? (await decide(input, plan));

			if (verdict.effectSource === "fallback") {
				notice(input, DEGRADED_NOTICE);
			}
			await logVerdict(input, verdict);

			if (options.mode === "enforce" && verdict.verdict === "block") {
				const reason =
					verdict.reason ?? degradedBlockReason(input.stage);
				input.notify?.(reason);
				return { block: true, reason };
			}
			return undefined;
		},
		reset() {
			jev = null;
			jevChain = Promise.resolve();
			dedupe.clear();
			degradedNotified = false;
		},
	};
}
