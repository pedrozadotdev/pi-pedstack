// Model-role routing: deterministic role resolution policy + Jev judgment
// scoring. Deterministic-first: TypeScript owns roles/thresholds/precedence;
// Jev only answers atomic `noul` questions.

import fs from "node:fs/promises";
import path from "node:path";
import type { JevQuestion, JevRequest, JevResult, JevRuntime } from "../jev/types";
import { createJevRuntime } from "../jev/runtime";
import { isStageKey, readAttempts, readLatestRecord } from "../stage-gate/store";
import {
	readPiPedstackConfig,
	resolveModelRolesConfig,
	resolveRoutingConfig,
	type ModelRolesConfig,
	type PiPedstackConfig,
	type RoutingThresholds,
	type StepConfig,
} from "./config-types";
import { readRoutingRecord, writeRoutingRecord } from "./routing-store";
import { isUnitNumber, readConfidence } from "./noul-read";
import { truncateUtf8ToBytes } from "./solution-recall";

// Re-exported so `model-routing.ts` stays the public entry point for routing
// policy while the schema-adjacent defaults live with the config definitions.
export { DEFAULT_MODEL_ROUTING } from "./config-types";
export type { RoutingThresholds } from "./config-types";

/** All named roles. `review` is never an execution target. */
export type ModelRole = "default" | "review" | "sota";

/** Roles normal execution may route to. */
export type ExecutionRole = "default" | "sota";

export type RoutingReason =
	| "override"
	| "gate_escalate"
	| "jev"
	| "budget_exhausted"
	| "fallback";

export type RoutingSource =
	| "override"
	| "deterministic"
	| "jev"
	| "budget"
	| "fallback";

/** One already-combined Jev judgment (see `scoreJudgment`). */
export interface JevJudgment {
	weighted: number;
	confidence: number;
	scores: Record<string, number>;
}

export interface RoleResolutionInput {
	overrideModel?: string | null;
	gateEscalate: boolean;
	jev: JevJudgment | null;
	escalations: number;
	thresholds: RoutingThresholds;
}

export interface RoleDecision {
	role: ExecutionRole;
	reason: RoutingReason;
	source: RoutingSource;
	weighted: number | null;
	confidence: number | null;
	scores: Record<string, number> | null;
	/** Present only when reason === "override"; role is nominal then. */
	overrideModel: string | null;
}

function plainDecision(
	role: ExecutionRole,
	reason: RoutingReason,
	source: RoutingSource,
	overrideModel: string | null = null,
): RoleDecision {
	return {
		role,
		reason,
		source,
		weighted: null,
		confidence: null,
		scores: null,
		overrideModel,
	};
}

/**
 * Deterministic role resolution. Precedence is fixed and ordered:
 * override -> gate_escalate -> jev -> fallback. The escalation budget caps
 * only proactive Jev-triggered `sota` selection; a deterministic gate
 * escalation is honored regardless of the budget so correctness always
 * outranks cost.
 */
export function resolveExecutionRole(input: RoleResolutionInput): RoleDecision {
	const override = input.overrideModel?.trim();
	if (override) {
		return plainDecision("default", "override", "override", override);
	}

	if (input.gateEscalate) {
		return plainDecision("sota", "gate_escalate", "deterministic");
	}

	const { jev } = input;
	if (
		jev &&
		jev.weighted >= input.thresholds.sotaMinScore &&
		jev.confidence >= input.thresholds.sotaMinConfidence
	) {
		if (input.escalations >= input.thresholds.maxEscalationsPerStage) {
			return {
				...plainDecision("default", "budget_exhausted", "budget"),
				weighted: jev.weighted,
				confidence: jev.confidence,
				scores: jev.scores,
			};
		}
		return {
			...plainDecision("sota", "jev", "jev"),
			weighted: jev.weighted,
			confidence: jev.confidence,
			scores: jev.scores,
		};
	}

	return plainDecision("default", "fallback", "fallback");
}

/** Fixed, weighted `noul` questions (weights sum to 1.0). */
export const ROUTING_QUESTIONS: readonly {
	readonly id: string;
	readonly weight: number;
	readonly instructions: string;
}[] = [
	{
		id: "complexity",
		weight: 0.25,
		instructions:
			"Does this task require reasoning well beyond a cheap workhorse?",
	},
	{
		id: "risk",
		weight: 0.2,
		instructions:
			"Would a wrong answer be expensive, hard to detect, or hard to reverse?",
	},
	{
		id: "cross_cutting",
		weight: 0.2,
		instructions:
			"Does the task touch many subsystems with shared blast radius?",
	},
	{
		id: "deep_reasoning",
		weight: 0.2,
		instructions:
			"Does the task require long multi-step chains a cheap model handles poorly?",
	},
	{
		id: "ambiguity",
		weight: 0.15,
		instructions:
			"Is the task underspecified such that a stronger model materially helps?",
	},
];

/** Build the one-shot routing request: bounded state + the five noul questions. */
export function buildRoutingRequest(
	state: Record<string, unknown>,
): JevRequest {
	const questions: Record<string, JevQuestion> = {};
	for (const question of ROUTING_QUESTIONS) {
		questions[question.id] = {
			type: "noul",
			instructions: question.instructions,
		};
	}
	return { state, questions };
}

/**
 * Deterministically combine the five `noul` answers into one judgment, or
 * `null` when any answer is missing/invalid (never fabricate a score).
 */
export function scoreJudgment(result: JevResult): JevJudgment | null {
	let weighted = 0;
	let confidence = 1;
	const scores: Record<string, number> = {};

	for (const question of ROUTING_QUESTIONS) {
		const answer = result.answers?.[question.id];
		if (!answer || answer.type !== "noul") return null;
		if (!isUnitNumber(answer.noul)) return null;
		const answerConfidence = readConfidence(
			answer as { confidence?: unknown },
		);
		if (answerConfidence === null) return null;

		scores[question.id] = answer.noul;
		weighted += question.weight * answer.noul;
		confidence = Math.min(confidence, answerConfidence);
	}

	return { weighted, confidence, scores };
}

const ROUTING_JEV_TIMEOUT_MS = 20_000;
const PROMPT_EXCERPT_BYTES = 2048;
const HANDOFF_EXCERPT_BYTES = 2048;
const PLAN_EXCERPT_BYTES = 4096;
const HANDOFF_LATEST_REL = path.join(
	".context",
	"compound-engineering",
	"handoffs",
	"latest.md",
);

export interface StageRoutingInput {
	repoRoot: string;
	stage: string;
	override?: StepConfig | null;
	prompt?: string | null;
	jev?: JevRuntime;
	now?: () => Date;
}

export interface StageRoutingResult {
	decision: RoleDecision;
	shadow: boolean;
	/** Model to apply, or null to keep legacy behavior (shadow/no roles/no config). */
	appliedModel: string | null;
	appliedThinkingLevel: string | null;
}

function safeFallbackResult(): StageRoutingResult {
	return {
		decision: plainDecision("default", "fallback", "fallback"),
		shadow: true,
		appliedModel: null,
		appliedThinkingLevel: null,
	};
}

function hasRoutingConfig(config: PiPedstackConfig): boolean {
	return config.models !== undefined || config.routing !== undefined;
}

/** Pick the model/thinking level to apply, or nulls in shadow/override/no-role cases. */
function resolveAppliedRole(
	decision: RoleDecision,
	roles: ModelRolesConfig,
	shadow: boolean,
): { model: string | null; thinkingLevel: string | null } {
	if (shadow || decision.reason === "override") {
		return { model: null, thinkingLevel: null };
	}
	const entry =
		decision.role === "sota" ? roles.sota ?? roles.default : roles.default;
	return {
		model: entry?.model ?? null,
		thinkingLevel: entry?.thinkingLevel ?? null,
	};
}

async function readBoundedFile(
	filePath: string,
	maxBytes: number,
): Promise<string | null> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		return truncateUtf8ToBytes(text, maxBytes);
	} catch {
		return null;
	}
}

/** Bounded, individually-guarded excerpts for the Jev judgment (never full context). */
async function buildRoutingState(
	input: StageRoutingInput,
): Promise<Record<string, unknown>> {
	const state: Record<string, unknown> = {};
	if (input.prompt) {
		state.task = truncateUtf8ToBytes(input.prompt, PROMPT_EXCERPT_BYTES);
	}

	const handoff = await readBoundedFile(
		path.join(input.repoRoot, HANDOFF_LATEST_REL),
		HANDOFF_EXCERPT_BYTES,
	);
	if (handoff) state.handoff = handoff;

	if (input.stage === "03-work") {
		const plan = await newestPlanExcerpt(input.repoRoot);
		if (plan) state.plan = plan;
	}

	return state;
}

async function newestPlanExcerpt(repoRoot: string): Promise<string | null> {
	try {
		const dir = path.join(repoRoot, "docs", "plans");
		const names = (await fs.readdir(dir))
			.filter((name) => name.endsWith(".md"))
			.sort();
		const newest = names[names.length - 1];
		if (!newest) return null;
		return await readBoundedFile(path.join(dir, newest), PLAN_EXCERPT_BYTES);
	} catch {
		return null;
	}
}

async function latestGateEscalates(
	repoRoot: string,
	stage: string,
): Promise<boolean> {
	if (!isStageKey(stage)) return false;
	try {
		const latest = await readLatestRecord(repoRoot, stage);
		return latest?.verdict === "escalate" || latest?.review?.action === "escalate";
	} catch {
		return false;
	}
}

interface RoutingCounts {
	attempts: number;
	revisions: number;
	reviews: number;
}

/** Derives attempt/revision/review counters from the retained gate attempts. */
async function readAttemptCounts(
	repoRoot: string,
	stage: string,
): Promise<RoutingCounts> {
	if (!isStageKey(stage)) return { attempts: 0, revisions: 0, reviews: 0 };
	try {
		const attempts = await readAttempts(repoRoot, stage);
		return {
			attempts: attempts.length,
			revisions: attempts.filter((entry) => entry.verdict === "revise").length,
			reviews: attempts.filter((entry) => entry.verdict === "review").length,
		};
	} catch {
		return { attempts: 0, revisions: 0, reviews: 0 };
	}
}

async function askJev(input: StageRoutingInput): Promise<JevJudgment | null> {
	try {
		const state = await buildRoutingState(input);
		const runtime = input.jev ?? createJevRuntime();
		const result = await runtime.decide(buildRoutingRequest(state), {
			timeoutMs: ROUTING_JEV_TIMEOUT_MS,
			cwd: input.repoRoot,
		});
		return scoreJudgment(result);
	} catch {
		return null;
	}
}

async function persistRoutingRecord(
	input: StageRoutingInput,
	decision: RoleDecision,
	counts: { escalations: number; attempts: number; revisions: number; reviews: number },
): Promise<void> {
	try {
		await writeRoutingRecord(input.repoRoot, {
			schema: 1,
			stage: input.stage,
			role: decision.role,
			reason: decision.reason,
			source: decision.source,
			scores: decision.scores,
			weighted: decision.weighted,
			confidence: decision.confidence,
			attempts: counts.attempts,
			escalations: counts.escalations,
			revisions: counts.revisions,
			reviews: counts.reviews,
			updatedAt: (input.now?.() ?? new Date()).toISOString(),
		});
	} catch {
		// ponytail: persistence must never abort stage entry.
	}
}

/**
 * Single I/O entry point for stage-entry routing. Reads config + newest
 * stage-gate verdict + prior routing record, optionally asks Jev, then returns
 * the decision and the model to apply (null in shadow / when unconfigured).
 * Never throws: any failure degrades to the safe fallback role.
 */
export async function resolveStageRouting(
	input: StageRoutingInput,
): Promise<StageRoutingResult> {
	try {
		const config = await readPiPedstackConfig(input.repoRoot);
		if (!config || !hasRoutingConfig(config)) {
			// AD-6: no Jev call and no persistence for unconfigured operators.
			return safeFallbackResult();
		}

		const roles = resolveModelRolesConfig(config);
		const routing = resolveRoutingConfig(config);

		const overrideModel = input.override?.model ?? null;
		// Deterministic-first: override, then the stage-gate verdict, short-circuit
		// before any Jev call.
		const gateEscalate =
			!overrideModel && (await latestGateEscalates(input.repoRoot, input.stage));
		const prior = await readRoutingRecord(input.repoRoot, input.stage);
		const priorEscalations = prior?.escalations ?? 0;

		const jev = overrideModel || gateEscalate ? null : await askJev(input);

		const decision = resolveExecutionRole({
			overrideModel,
			gateEscalate,
			jev,
			escalations: priorEscalations,
			thresholds: routing,
		});

		const shadow = routing.shadow;
		const applied = resolveAppliedRole(decision, roles, shadow);
		// The budget caps only proactive Jev selection that actually applies a
		// role model. Deterministic gate escalation is exempt (a cost cap must
		// never suppress a quality escalation), and shadow mode applies nothing
		// so it consumes nothing.
		const proactiveJevEscalation =
			!shadow && decision.reason === "jev" && applied.model !== null;
		const counts = await readAttemptCounts(input.repoRoot, input.stage);
		await persistRoutingRecord(input, decision, {
			escalations: priorEscalations + (proactiveJevEscalation ? 1 : 0),
			...counts,
		});

		return {
			decision,
			shadow,
			appliedModel: applied.model,
			appliedThinkingLevel: applied.thinkingLevel,
		};
	} catch {
		return safeFallbackResult();
	}
}
