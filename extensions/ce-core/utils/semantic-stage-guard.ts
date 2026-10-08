/**
 * Pure policy + verdict layer for the Jev semantic stage guard.
 *
 * Maps a deterministic {@link DeterministicPlan} (effect + literal targets) to a
 * verdict by reusing `classifyPath`/`evaluateWrite`, builds the two bounded Jev
 * questions, and maps Jev answers back to a verdict under TypeScript thresholds.
 * All allow/block policy lives here; Jev returns bounded signals, not verdicts.
 *
 * @module semantic-stage-guard
 */

import {
	classifyCommandEffect,
	type EffectClass,
} from "./command-effect";
import {
	evaluateWrite,
	STAGE_CAPABILITIES,
	type PathClass,
} from "./capability-matrix";
import type { PipelineStageKey } from "../commands/pedstack";
import type {
	JevChoiceAnswer,
	JevContent,
	JevNoulAnswer,
	JevRequest,
	JevResult,
} from "../jev/types";

// ── Frozen integration constants ───────────────────────────────────

export const GUARD_JEV_TIMEOUT_MS = 8_000;
export const JEV_COMMAND_STATE_MAX_CHARS = 2_000;
export const TRUNCATION_MARKER = "…[truncated]";
export const MESSAGE_COMMAND_MAX_CHARS = 120;
export const DEDUPE_CACHE_MAX = 50;

export const MIN_EFFECT_CONFIDENCE = 0.6;
export const MIN_INTENT_CONFIDENCE = 0.5;

export type GuardMode = "off" | "shadow" | "enforce";
export type GuardEffectSource = "deterministic" | "jev" | "fallback";

/** Shadow JSONL record schema (calibration input). */
export interface GuardLogRecord {
	ts: string;
	stage: string | null;
	toolName: string;
	effectSource: GuardEffectSource;
	effect: EffectClass;
	intent?: boolean;
	jevConfidence?: number;
	deterministicTargets: Array<{ path: string; class: PathClass; allow: boolean }>;
	verdict: "allow" | "block";
	mode: GuardMode;
	fallbackReason?: string;
}

export interface DeterministicTarget {
	path: string;
	pathClass: PathClass;
	allow: boolean;
}

export interface DeterministicPlan {
	effect: EffectClass;
	targets: DeterministicTarget[];
	needsJev: boolean;
	fallbackReason?: string;
	/** Present when the decision is deterministic (no Jev call required). */
	verdict?: GuardVerdict;
}

export interface GuardVerdict {
	verdict: "allow" | "block";
	effect: EffectClass;
	effectSource: GuardEffectSource;
	intent?: boolean;
	jevConfidence?: number;
	targets: DeterministicTarget[];
	fallbackReason?: string;
	reason?: string;
}

// ── Stage policy tables ────────────────────────────────────────────

const TEST_BUILD_STAGES: ReadonlySet<string> = new Set([
	"03-work",
	"04-5-debug",
	"04-review",
]);

const STAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(STAGE_CAPABILITIES));

function knownStage(stage: string | null | undefined): PipelineStageKey | null {
	return typeof stage === "string" && STAGE_KEYS.has(stage)
		? (stage as PipelineStageKey)
		: null;
}

/** `probe.ts` classifies as the `source` class in any repo root. */
const SOURCE_PROBE_PATH = "probe.ts";

function sourceWritable(
	stage: string | null | undefined,
	repoRoot: string,
): boolean {
	return evaluateWrite(stage, repoRoot, SOURCE_PROBE_PATH).allow;
}

function capabilitiesFor(stage: string | null | undefined): string[] {
	const key = knownStage(stage);
	if (!key) return [];
	return [...STAGE_CAPABILITIES[key]].sort();
}

// ── Block message templates ────────────────────────────────────────

const OVERRIDE_HINT =
	'Set "features.stageGuard.disabled": true in config.json to bypass.';

function literalTargetReason(
	stage: string,
	effect: EffectClass,
	target: DeterministicTarget,
): string {
	return (
		`Pedstack stage guard blocked this bash command: stage "${stage}" ` +
		`cannot \`${effect}\` because it targets "${target.path}" ` +
		`(class: ${target.pathClass}). ${OVERRIDE_HINT}`
	);
}

function policyReason(stage: string, effect: EffectClass): string {
	return (
		`Pedstack stage guard blocked this bash command: stage "${stage}" ` +
		`cannot \`${effect}\`. ${OVERRIDE_HINT}`
	);
}

function unknownTargetReason(stage: string, effect: EffectClass): string {
	return (
		`Pedstack stage guard blocked this bash command: stage "${stage}" ` +
		`cannot \`${effect}\` with no resolvable target. ${OVERRIDE_HINT}`
	);
}

function jevBlockReason(
	stage: string,
	effect: EffectClass,
	confidence: number,
): string {
	return (
		`Pedstack stage guard blocked this bash command: stage "${stage}" ` +
		`effect \`${effect}\` with source-modifying intent ` +
		`(semantic, confidence ${confidence.toFixed(2)}). ${OVERRIDE_HINT}`
	);
}

// ── Deterministic planning ─────────────────────────────────────────

function allowVerdict(plan: {
	effect: EffectClass;
	targets: DeterministicTarget[];
}): GuardVerdict {
	return {
		verdict: "allow",
		effect: plan.effect,
		effectSource: "deterministic",
		targets: plan.targets,
	};
}

function deterministicBlock(
	plan: { effect: EffectClass; targets: DeterministicTarget[] },
	stage: string,
	target: DeterministicTarget,
): DeterministicPlan {
	const verdict: GuardVerdict = {
		verdict: "block",
		effect: plan.effect,
		effectSource: "deterministic",
		targets: plan.targets,
		reason: literalTargetReason(stage, plan.effect, target),
	};
	return { ...plan, needsJev: false, verdict };
}

function policyVerdict(
	plan: { effect: EffectClass; targets: DeterministicTarget[] },
	stage: string,
	allowed: boolean,
): DeterministicPlan {
	const verdict: GuardVerdict = allowed
		? allowVerdict(plan)
		: {
				verdict: "block",
				effect: plan.effect,
				effectSource: "deterministic",
				targets: plan.targets,
				reason: policyReason(stage, plan.effect),
			};
	return { ...plan, needsJev: false, verdict };
}

function needsJevPlan(
	plan: { effect: EffectClass; targets: DeterministicTarget[] },
	reason: string,
): DeterministicPlan {
	return { ...plan, needsJev: true, fallbackReason: reason, verdict: undefined };
}

function decideDeterministic(
	stageKey: PipelineStageKey,
	stage: string,
	plan: { effect: EffectClass; targets: DeterministicTarget[] },
	unresolvable: boolean,
): DeterministicPlan {
	const { effect, targets } = plan;
	if (effect === "read_only") {
		return { ...plan, needsJev: false, verdict: allowVerdict(plan) };
	}
	if (effect === "runs_tests_or_builds") {
		return policyVerdict(plan, stage, TEST_BUILD_STAGES.has(stageKey));
	}
	if (effect === "installs_dependencies") {
		return policyVerdict(plan, stage, stageKey === "03-work");
	}

	const blocked = targets.find((target) => !target.allow);
	if (blocked) return deterministicBlock(plan, stage, blocked);

	if (effect === "mutates_workspace") {
		if (unresolvable) return needsJevPlan(plan, "unresolvable target");
		return { ...plan, needsJev: false, verdict: allowVerdict(plan) };
	}
	if (effect === "deletes_or_destructive") {
		if (unresolvable || targets.length === 0) {
			return needsJevPlan(plan, "unresolvable target");
		}
		return { ...plan, needsJev: false, verdict: allowVerdict(plan) };
	}
	return needsJevPlan(plan, `effect ${effect} requires Jev`);
}

/**
 * Plan the deterministic decision for a raw bash command.
 *
 * Absent/unknown stages fail open for ordinary project paths, matching
 * `evaluateWrite`, but protected `.context` targets that `evaluateWrite`
 * rejects remain deterministically blocked.
 */
export function planCommandGuard(
	stage: string | null | undefined,
	repoRoot: string,
	command: string,
): DeterministicPlan {
	const classified = classifyCommandEffect(command);
	const targets: DeterministicTarget[] = classified.targets.map((path) => {
		const verdict = evaluateWrite(stage, repoRoot, path);
		return { path, pathClass: verdict.pathClass, allow: verdict.allow };
	});
	const plan = { effect: classified.effect, targets };
	const stageKey = knownStage(stage);

	if (!stageKey) {
		const blocked = targets.find((target) => !target.allow);
		if (blocked) {
			return deterministicBlock(plan, stage ?? "no-active-stage", blocked);
		}
		return { ...plan, needsJev: false, verdict: allowVerdict(plan) };
	}
	return decideDeterministic(
		stageKey,
		stage as string,
		plan,
		classified.unresolvable,
	);
}

// ── Jev request building ───────────────────────────────────────────

const EFFECT_CRITERIA: Record<string, string> = {
	read_only: "Reads files or prints output without modifying the workspace.",
	mutates_workspace: "Creates, edits, moves, or copies files in the workspace.",
	deletes_or_destructive: "Deletes, truncates, or irreversibly overwrites files.",
	installs_dependencies: "Installs or upgrades package dependencies.",
	runs_tests_or_builds: "Runs tests, type checks, or builds without editing files.",
	package_runner: "Runs an unknown package script that may mutate the workspace.",
	pipe_to_shell: "Pipes remote or generated content into a shell interpreter.",
	container_or_remote: "Runs a container, cluster, or remote command.",
	ambiguous: "The effect cannot be determined from the command alone.",
};

const EFFECT_INSTRUCTIONS =
	"Classify the primary effect of this shell command on the workspace.";
const INTENT_INSTRUCTIONS =
	"Is the primary intent of this command to modify source or project files " +
	"(not merely run tests/builds or read)?";
const INTENT_TRUE = "Yes, it intends to modify project files.";
const INTENT_FALSE = "No, it only reads, tests, or builds.";

/** Mask env assignments and quoted literal contents before logging/asking. */
export function redactCommand(command: string): string {
	return command
		.replace(/'[^']*'|"[^"]*"/g, "'***'")
		.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, "$1$2=***");
}

/** Cap a command to `maxChars`, appending the marker only when truncated. */
export function truncateCommand(command: string, maxChars: number): string {
	return command.length <= maxChars
		? command
		: `${command.slice(0, maxChars)}${TRUNCATION_MARKER}`;
}

/** Build the two bounded Jev questions for a plan that needs Jev. */
export function buildGuardRequest(
	stage: string | null | undefined,
	command: string,
	plan: DeterministicPlan,
): JevRequest {
	const state: Record<string, unknown> = {
		stage: stage ?? null,
		effect: plan.effect,
		command: truncateCommand(redactCommand(command), JEV_COMMAND_STATE_MAX_CHARS),
		targets: plan.targets.map((target) => ({
			path: target.path,
			class: target.pathClass,
			allow: target.allow,
		})),
		capabilities: capabilitiesFor(stage),
	};

	return {
		state: state as JevContent,
		questions: {
			effect: {
				type: "choice",
				instructions: EFFECT_INSTRUCTIONS,
				criteria: EFFECT_CRITERIA as Record<string, JevContent>,
			},
			intent: {
				type: "noul",
				instructions: INTENT_INSTRUCTIONS,
				criteria: { true: INTENT_TRUE, false: INTENT_FALSE },
			},
		},
	};
}

// ── Jev verdict mapping ────────────────────────────────────────────

function fallbackVerdict(plan: DeterministicPlan, reason: string): GuardVerdict {
	return {
		verdict: "allow",
		effect: plan.effect,
		effectSource: "fallback",
		targets: plan.targets,
		fallbackReason: reason,
	};
}

interface MappedSignals {
	effect: EffectClass;
	intent: boolean;
	confidence: number;
}

function readSignals(result: JevResult): MappedSignals | string {
	const effectAnswer = result.answers?.effect;
	const intentAnswer = result.answers?.intent;
	if (!effectAnswer || effectAnswer.type !== "choice") {
		return "missing effect answer";
	}
	if (!intentAnswer || intentAnswer.type !== "noul") {
		return "missing intent answer";
	}
	const choice = effectAnswer as JevChoiceAnswer;
	const noul = intentAnswer as JevNoulAnswer;
	if (typeof choice.confidence !== "number" || choice.confidence < MIN_EFFECT_CONFIDENCE) {
		return "below effect confidence threshold";
	}
	if (!Object.hasOwn(EFFECT_CRITERIA, choice.choice)) {
		return `unmapped effect "${choice.choice}"`;
	}
	if (noul.confidence === undefined || noul.confidence < MIN_INTENT_CONFIDENCE) {
		return "below intent confidence threshold";
	}
	return {
		effect: choice.choice as EffectClass,
		intent: noul.noul >= 0.5,
		confidence: choice.confidence,
	};
}

function jevAllow(
	plan: DeterministicPlan,
	signals: MappedSignals,
): GuardVerdict {
	return {
		verdict: "allow",
		effect: signals.effect,
		effectSource: "jev",
		intent: signals.intent,
		jevConfidence: signals.confidence,
		targets: plan.targets,
	};
}

function jevBlock(
	plan: DeterministicPlan,
	signals: MappedSignals,
	stage: string,
	reason: string,
): GuardVerdict {
	return {
		verdict: "block",
		effect: signals.effect,
		effectSource: "jev",
		intent: signals.intent,
		jevConfidence: signals.confidence,
		targets: plan.targets,
		reason,
	};
}

/**
 * Map Jev answers onto the stage policy under TypeScript thresholds.
 *
 * A fallback never blocks; a block is only produced by an explicit mapping.
 */
export function applyJevAnswers(
	stage: string | null | undefined,
	repoRoot: string,
	plan: DeterministicPlan,
	result: JevResult,
): GuardVerdict {
	const stageKey = knownStage(stage);
	if (!stageKey) return fallbackVerdict(plan, "unknown stage");

	const signals = readSignals(result);
	if (typeof signals === "string") return fallbackVerdict(plan, signals);

	return mapSignals(stageKey, stage as string, repoRoot, plan, signals);
}

function jevPolicyVerdict(
	plan: DeterministicPlan,
	signals: MappedSignals,
	stage: string,
	allowed: boolean,
): GuardVerdict {
	return allowed
		? jevAllow(plan, signals)
		: jevBlock(plan, signals, stage, policyReason(stage, signals.effect));
}

function mapDestructive(
	plan: DeterministicPlan,
	signals: MappedSignals,
	stage: string,
): GuardVerdict {
	if (plan.targets.length === 0) {
		return jevBlock(
			plan,
			signals,
			stage,
			unknownTargetReason(stage, signals.effect),
		);
	}
	return jevAllow(plan, signals);
}

function mapMutates(
	stage: string,
	repoRoot: string,
	plan: DeterministicPlan,
	signals: MappedSignals,
): GuardVerdict {
	if (!signals.intent) return jevAllow(plan, signals);
	if (plan.targets.length === 0 && !sourceWritable(stage, repoRoot)) {
		return jevBlock(
			plan,
			signals,
			stage,
			jevBlockReason(stage, signals.effect, signals.confidence),
		);
	}
	return jevAllow(plan, signals);
}

function mapSignals(
	stageKey: PipelineStageKey,
	stage: string,
	repoRoot: string,
	plan: DeterministicPlan,
	signals: MappedSignals,
): GuardVerdict {
	const { effect } = signals;
	if (effect === "read_only") return jevAllow(plan, signals);
	if (effect === "installs_dependencies") {
		return jevPolicyVerdict(plan, signals, stage, stageKey === "03-work");
	}
	if (effect === "runs_tests_or_builds") {
		return jevPolicyVerdict(
			plan,
			signals,
			stage,
			TEST_BUILD_STAGES.has(stageKey),
		);
	}

	const blocked = plan.targets.find((target) => !target.allow);
	if (blocked) {
		return jevBlock(
			plan,
			signals,
			stage,
			jevBlockReason(stage, effect, signals.confidence),
		);
	}
	if (effect === "deletes_or_destructive") {
		return mapDestructive(plan, signals, stage);
	}
	if (effect === "mutates_workspace") {
		return mapMutates(stage, repoRoot, plan, signals);
	}
	return fallbackVerdict(plan, `unmapped effect "${effect}"`);
}

