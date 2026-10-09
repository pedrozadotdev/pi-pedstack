import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { readFile } from "node:fs/promises";

import {
	readPiPedstackConfig,
	getConfigKeyForSkill,
	type StepConfig,
} from "../utils/config-types";
import { resolveStageRouting } from "../utils/model-routing";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import { startDiagnosticStage, recordDiagnostic, diagnosticJevOptions, setDiagnosticRole, resetDiagnosticWorkflow } from "../diagnostics";
import {
	loadAllAppendContext,
	loadAppendContext,
} from "../utils/append-loader";
import { parseModelRef } from "../utils/parse-model-ref";
import {
	createWorkflowStateTool,
	type WorkflowStateResult,
} from "../tools/workflow-state";
import { createContextHandoffTool } from "../tools/context-handoff";
import {
	setActiveStage,
	getActiveStage,
	clearActiveStage,
	persistActiveStage,
	readPersistedActiveStage,
} from "../utils/active-stage";
import { resetWorkflowRoutingState } from "../utils/workflow-reset";
import {
	countStructuredFindings,
	parseReviewOutcome,
	requiredNextStageForReview,
} from "../utils/review-outcome";

// ── Skill registry (populated from before_agent_start) ─────────────

/** In-memory skill registry: stageKey → absolute SKILL.md path. */
const skillRegistry = new Map<string, string>();

/**
 * Initialize the skill registry from Pi's loaded skills.
 * Call this from a `before_agent_start` handler in index.ts.
 */
export function initSkillRegistry(
	skills: Array<{ name: string; filePath: string }>,
): void {
	for (const skill of skills) {
		skillRegistry.set(skill.name, skill.filePath);
	}
}

// ── Pending skill path for system prompt injection ─────────────────

/** Skill path the next before_agent_start handler should inject into system prompt. */
let pendingSkillPath: string | null = null;

/** Issue numbers for the next before_agent_start handler to inject fetch instructions. */
let pendingFixIssues: string[] = [];

/** Per-stage APPEND.md content to inject into the next system prompt. */
let pendingAppendContent: string | null = null;

/**
 * Most recent command context that started or resumed the workflow.
 *
 * ponytail: auto-advance reuses this same-session command ctx after agent_end
 * because tool/event contexts cannot navigate the session tree themselves.
 */
let rememberedCommandContext: ExtensionCommandContext | null = null;

/** Store append content for the next before_agent_start invocation. */
export function setPendingAppendContent(content: string | null): void {
	pendingAppendContent = content;
}

/** Retrieve and clear the stored append content. */
export function getAndClearPendingAppendContent(): string | null {
	const c = pendingAppendContent;
	pendingAppendContent = null;
	return c;
}

/** Store a skill path for the next agent turn. */
export function setPendingSkillPath(path: string | null): void {
	pendingSkillPath = path;
}

/** Retrieve and clear the stored skill path. */
export function getAndClearPendingSkillPath(): string | null {
	const p = pendingSkillPath;
	pendingSkillPath = null;
	return p;
}

/**
 * Store issue numbers for the next before_agent_start invocation.
 * Stores a defensive copy to prevent mutation from outside.
 */
export function setPendingFixIssues(numbers: string[]): void {
	pendingFixIssues = [...numbers];
}

/**
 * Retrieve and clear the stored issue numbers.
 * Returns an empty array when nothing is stored.
 */
export function getAndClearPendingFixIssues(): string[] {
	const n = pendingFixIssues;
	pendingFixIssues = [];
	return n;
}

/** Reset all pedstack pending state (call in afterEach / session cleanup). */
export function resetPedstackState(): void {
	pendingSkillPath = null;
	pendingFixIssues = [];
	pendingAppendContent = null;
	rememberedCommandContext = null;
	clearActiveStage();
}

/**
 * Activate a stage in memory and best-effort persist it.
 *
 * ponytail: persistence must never abort dispatch; the in-memory value is
 * enough to guard the live session.
 */
async function activateStage(repoRoot: string, stage: string): Promise<void> {
	setActiveStage(stage);
	await startDiagnosticStage(stage);
	try {
		await persistActiveStage(repoRoot, stage);
	} catch {
		// Persistence is best-effort; the in-memory stage still guards this session.
	}
}

/**
 * Test seam: replaces the workflow-root reset so tests can simulate a
 * filesystem failure. `null` restores the real implementation. Mirrors
 * `__setModelRoutingJevFactory`.
 */
let workflowResetImpl: (repoRoot: string) => Promise<void> =
	resetWorkflowRoutingState;

/** @internal Test-only injection seam for workflow-root reset failures. */
export function __setWorkflowReset(
	impl: ((repoRoot: string) => Promise<void>) | null,
): void {
	workflowResetImpl = impl ?? resetWorkflowRoutingState;
}

/**
 * Reset workflow-scoped routing state at a genuine workflow root (`/ped-start`,
 * `/ped-fix-issues`). The new workflow must not inherit the previous one's
 * proactive escalation budget or stage-gate escalation verdict.
 *
 * Returns false after notifying the operator when the reset fails; the caller
 * must then abort workflow initialization rather than start on stale state.
 */
async function resetWorkflowScopedState(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	try {
		await workflowResetImpl(ctx.cwd);
		return true;
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Failed to reset prior workflow state: ${formatError(err)}. New workflow not started; resolve the problem and retry.`,
				"error",
			);
		}
		return false;
	}
}

/** Remember the latest live command context for same-session auto-advance. */
export function rememberCommandContext(ctx: ExtensionCommandContext): void {
	rememberedCommandContext = ctx;
}

/** Clear the cached command context after session replacement or shutdown. */
export function clearRememberedCommandContext(): void {
	rememberedCommandContext = null;
}

/**
 * Parse issue numbers from a raw argument string.
 * Trims, splits on whitespace, strips non-digit characters, filters empties,
 * deduplicates (order-preserving), caps at 10.
 * Returns an empty array if no valid numbers found.
 */
export function parseIssueNumbers(raw: string): string[] {
	const segments = raw
		.split(/\s+/)
		.map((s) => s.replace(/\D/g, ""))
		.filter(Boolean);
	const deduped = [...new Set(segments)];
	return deduped.slice(0, 10);
}

/** Compute the absolute SKILL.md path for a given stage key. */
export function computeSkillPath(stageKey: string): string {
	// Prefer Pi's registered path, fall back to extension-relative path
	const registered = skillRegistry.get(stageKey);
	if (registered) return registered;
	const pkgDir = path.resolve(
		import.meta.dirname ?? __dirname,
		"..",
		"..",
		"..",
	);
	return path.join(pkgDir, "skills", stageKey, "SKILL.md");
}

// ── Types ──────────────────────────────────────────────────────────

/** Minimal session interface for tree traversal helpers. */
export interface ReadonlySessionLike {
	getLeafId(): string | null;
	getBranch(): SessionEntry[];
}

/**
 * Pi thinking levels. `"max"` is supported by `@earendil-works/pi-agent-core`
 * 0.80.6+ (the devDependency range); older harnesses clamp an unknown level
 * when it is applied.
 */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Pipeline stage keys corresponding to skills in 00-next. */
export type PipelineStageKey =
	| "01-brainstorm"
	| "02-plan"
	| "03-work"
	| "04-review"
	| "04-5-debug"
	| "05-learn"
	| "06-docsync";

/** Result of stage resolution — either a valid next stage or an abort reason. */
export type StageResolution =
	| { ok: true; stage: PipelineStageKey }
	| {
			ok: false;
			reason: "critical_health";
			details: { currentStage?: string; latestHandoffPath?: string };
	  }
	| {
			ok: false;
			reason: "blocker";
			details: { currentStage?: string; blocker: string };
	  }
	| {
			ok: false;
			reason: "new_session_recommended";
			details: { nextStage?: string; latestHandoffPath?: string };
	  }
	| { ok: false; reason: "ambiguous" };

const VALID_STAGE_KEYS = new Set<string>([
	"01-brainstorm",
	"02-plan",
	"03-work",
	"04-review",
	"04-5-debug",
	"05-learn",
	"06-docsync",
]);

/** Runtime type guard for PipelineStageKey. */
export function isValidStageKey(s: string): s is PipelineStageKey {
	return VALID_STAGE_KEYS.has(s);
}

// ── Session-traversal helpers ──────────────────────────────────────

/** Whether an entry participates in LLM context (messages, summaries, custom messages). */
export function isModelVisible(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "custom_message"
	);
}

/**
 * Find the first model-visible entry on the current branch (closest to root).
 * Returns null if no visible entries exist or no leaf is set.
 */
export function findPreConversationEntry(
	session: ReadonlySessionLike,
): SessionEntry | null {
	const leafId = session.getLeafId();
	if (!leafId) return null;

	for (const entry of session.getBranch()) {
		if (isModelVisible(entry)) return entry;
	}

	return null;
}

/**
 * Find the target ID for navigating to a fresh context.
 * Returns the parent of the first model-visible entry, or the branch root as fallback.
 * Returns null if the branch is empty.
 */
export function findFreshTargetId(session: ReadonlySessionLike): string | null {
	const branch = session.getBranch();
	if (branch.length === 0) return null;

	const firstVisible = findPreConversationEntry(session);
	if (firstVisible) return firstVisible.parentId ?? firstVisible.id;

	return branch[0].parentId ?? branch[0].id;
}

// ── Thinking level map ─────────────────────────────────────────────

const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	"0": "low",
	"1": "medium",
	"2": "high",
};

// ── Stage resolution logic ─────────────────────────────────────────

/**
 * Map the most recent artifact to its producing stage.
 * Uses artifact count (non-zero = exists), ordered: solutions > reviews > plans > brainstorms.
 */
function getStageFromLatestArtifact(
	state: WorkflowStateResult,
): PipelineStageKey | null {
	const candidates: Array<{ count: number; stage: PipelineStageKey }> = [
		{ count: state.solutions.count, stage: "05-learn" },
		{ count: state.reviews.count, stage: "04-review" },
		{ count: state.plans.count, stage: "02-plan" },
		{ count: state.brainstorms.count, stage: "01-brainstorm" },
	];

	const nonZero = candidates.filter((c) => c.count > 0);
	return nonZero.length > 0 ? nonZero[0].stage : null;
}

/**
 * Resolve the next pipeline stage based on workflow state.
 *
 * Applies the 6-priority chain from recommendation-logic.md:
 * 1. Critical context health → abort
 * 2. Active blocker → abort
 * 3. New session recommended → abort
 * 4. Explicit next stage → return it
 * 5. Stage mismatch (artifact vs current) → return artifact stage
 * 6. Fallback: artifact-count rules → first missing stage
 */
export function resolveNextPipelineStage(
	state: WorkflowStateResult,
): StageResolution {
	const ctx = state.context;

	// Priority 1: Critical context health
	if (ctx.contextHealth === "critical") {
		return {
			ok: false,
			reason: "critical_health",
			details: {
				currentStage: ctx.currentStage,
				latestHandoffPath: ctx.latestHandoffPath,
			},
		};
	}

	// Priority 2: Active blocker
	if (ctx.blocker && ctx.blocker !== "N/A") {
		return {
			ok: false,
			reason: "blocker",
			details: {
				currentStage: ctx.currentStage,
				blocker: ctx.blocker,
			},
		};
	}

	// Priority 3: New session recommended
	if (ctx.recommendNewSession === true && ctx.nextStage) {
		return {
			ok: false,
			reason: "new_session_recommended",
			details: {
				nextStage: ctx.nextStage,
				latestHandoffPath: ctx.latestHandoffPath,
			},
		};
	}

	// Priority 4: Explicit next stage (with runtime validation)
	if (ctx.nextStage && ctx.nextStage !== ctx.currentStage) {
		if (isValidStageKey(ctx.nextStage)) {
			return { ok: true, stage: ctx.nextStage };
		}
		return { ok: false, reason: "ambiguous" };
	}

	// Priority 5: Stage mismatch — map most recent artifact to its producing stage
	const latestStage = getStageFromLatestArtifact(state);
	if (latestStage && ctx.currentStage && latestStage !== ctx.currentStage) {
		return { ok: true, stage: latestStage };
	}

	// Priority 6: Fallback — artifact-count rules
	if (state.brainstorms.count === 0)
		return { ok: true, stage: "01-brainstorm" };
	if (state.plans.count === 0) return { ok: true, stage: "02-plan" };
	if (state.plans.count > 0) return { ok: true, stage: "03-work" };

	return { ok: false, reason: "ambiguous" };
}

// ── Config-switching helpers (split from switchStageConfig) ────────

/** Switch model if stepConfig specifies one and it differs from current. */
async function switchModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
	stepConfig: { model?: string },
): Promise<"applied" | "unchanged" | "missing_model" | "invalid_model" | "model_unavailable" | "api_key"> {
	if (!stepConfig.model) return "missing_model";

	const parsed = parseModelRef(stepConfig.model, ctx.model?.provider);
	if (!parsed) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Invalid model for ${stageKey}: ${stepConfig.model}`,
				"warning",
			);
		}
		return "invalid_model";
	}

	if (ctx.model?.provider === parsed.provider && ctx.model?.id === parsed.id) {
		return "unchanged";
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Model not found for ${stageKey}: ${stepConfig.model}`,
				"warning",
			);
		}
		return "model_unavailable";
	}

	const switched = await pi.setModel(model);
	if (switched && ctx.hasUI) {
		ctx.ui.notify(
			`Switched model for ${stageKey}: ${model.provider}/${model.id}`,
			"info",
		);
	} else if (!switched && ctx.hasUI) {
		ctx.ui.notify(
			`No API key for ${stageKey}: ${model.provider}/${model.id}`,
			"warning",
		);
	}
	return switched ? "applied" : "api_key";
}

/** Switch thinking level if stepConfig specifies one and it differs from current. */
function switchThinkingLevel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
	stepConfig: { thinkingLevel?: string },
): void {
	if (!stepConfig.thinkingLevel) return;

	const normalized =
		THINKING_LEVEL_MAP[stepConfig.thinkingLevel.toLowerCase()];
	if (!normalized) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Invalid thinking level for ${stageKey}: ${stepConfig.thinkingLevel}`,
				"warning",
			);
		}
		return;
	}
	const currentLevel = pi.getThinkingLevel();
	if (currentLevel !== normalized) {
		pi.setThinkingLevel(normalized);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Switched thinking level for ${stageKey}: ${normalized}`,
				"info",
			);
		}
	}
}

/** Load APPEND.md context for the given stage. Stores it so buildSystemPromptAppend can inject it. */
async function loadStageAppend(
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
): Promise<void> {
	// Load the global ALL.md (applies to every stage) and the stage-specific file
	const [allContent, stageContent] = await Promise.all([
		loadAllAppendContext(ctx.cwd),
		loadAppendContext(ctx.cwd, stageKey),
	]);

	let combined: string | null = null;
	if (allContent && stageContent) {
		combined = `${allContent}\n\n${stageContent}`;
	} else if (allContent) {
		combined = allContent;
	} else if (stageContent) {
		combined = stageContent;
	}

	if (combined) {
		setPendingAppendContent(combined);
		if (ctx.hasUI) {
			const label = allContent ? `${stageKey} + ALL` : stageKey;
			ctx.ui.notify(`Loaded APPEND.md context for ${label}`, "info");
		}
	}
}

/**
 * Test seam: allows tests to inject a fake routing Jev runtime without
 * spawning `cmd`. Mirrors `__setStageGuardJevFactory` in index.ts.
 */
let modelRoutingJevFactory: (() => JevRuntime) | null = null;

/** @internal Test-only injection seam for the routing Jev runtime. */
export function __setModelRoutingJevFactory(
	factory: (() => JevRuntime) | null,
): void {
	modelRoutingJevFactory = factory;
}

function getRoutingJevRuntime(): JevRuntime {
	try {
		return modelRoutingJevFactory ? modelRoutingJevFactory() : createJevRuntime({ ...diagnosticJevOptions("routing", getActiveStage) });
	} catch {
		// ponytail: a broken factory degrades to fallback, never aborts stage entry.
		return {
			decide: async () => {
				throw new Error("routing Jev factory failed");
			},
		};
	}
}

/** Apply the resolved role model/thinking level, shadow-safe and non-fatal. */
async function applyRoleModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
	stepConfig: StepConfig | null,
	prompt?: string,
): Promise<void> {
	try {
		const result = await resolveStageRouting({
			repoRoot: ctx.cwd,
			stage: stageKey,
			override: stepConfig,
			prompt: prompt ?? null,
			jev: getRoutingJevRuntime(),
		});
		recordDiagnostic({ feature: "routing", event: "role_selected", stage: stageKey, role: result.decision.role, outcome: "success" });
		setDiagnosticRole(result.shadow ? "unknown" : (result.decision.reason === "override" ? "override" : result.decision.role));

		if (result.shadow) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[routing] ${stageKey}: ${result.decision.role} (${result.decision.reason}) — shadow mode, not applied; set routing.shadow=false to enforce`,
					"info",
				);
			}
			return;
		}

		if (result.appliedModel && result.appliedRole) {
			let activation: Awaited<ReturnType<typeof switchModel>> | "switch_failed";
			try {
				activation = await switchModel(pi, ctx, stageKey, { model: result.appliedModel });
			} catch {
				activation = "switch_failed";
			}
			if (activation === "applied" || activation === "unchanged") {
				recordDiagnostic({ feature: "routing", event: "role_applied", stage: stageKey, role: result.appliedRole, outcome: "success" });
			} else {
				recordDiagnostic({
					feature: "routing", event: "role_apply_failed", stage: stageKey,
					role: result.decision.role, outcome: "failure",
					routingApplyFailure: activation,
				});
			}
		} else if (!result.shadow && result.decision.role === "sota") {
			recordDiagnostic({
				feature: "routing", event: "role_apply_failed", stage: stageKey,
					role: result.decision.role, outcome: "failure", routingApplyFailure: "missing_model",
			});
		}
		if (result.appliedThinkingLevel) {
			switchThinkingLevel(pi, ctx, stageKey, {
				thinkingLevel: result.appliedThinkingLevel,
			});
		}
	} catch {
		// Routing must never abort stage entry; legacy behavior stands.
	}
}

/** Orchestrate model, thinking, and APPEND.md switching for a pipeline stage. */
async function switchStageConfig(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
	prompt?: string,
): Promise<void> {
	const config = await readPiPedstackConfig(ctx.cwd);
	const configKey = getConfigKeyForSkill(stageKey);
	const stepConfig = configKey ? config?.[configKey] : null;
	// AD-6: unconfigured operators get byte-identical legacy behavior.
	const routingConfigured =
		config?.models !== undefined || config?.routing !== undefined;

	await switchModel(pi, ctx, stageKey, stepConfig ?? {});
	switchThinkingLevel(pi, ctx, stageKey, stepConfig ?? {});
	if (routingConfigured) {
		await applyRoleModel(pi, ctx, stageKey, stepConfig ?? null, prompt);
	} else {
		setDiagnosticRole(stepConfig?.model ? "override" : "default");
	}
	await loadStageAppend(ctx, stageKey);
}

// ── Navigation setup (shared between commands) ────────────────────

interface NavigationSetup {
	departureLeafId: string;
	freshTargetId: string;
}

/**
 * Capture departure leafId and find fresh target for clean branching.
 * Returns null if any step fails (caller should abort).
 */
async function prepareStageNavigation(
	ctx: ExtensionCommandContext,
): Promise<NavigationSetup | null> {
	const departureLeafId = ctx.sessionManager.getLeafId();
	if (!departureLeafId) {
		if (ctx.hasUI) ctx.ui.notify("No active session leaf.", "warning");
		return null;
	}

	const freshTargetId = findFreshTargetId(ctx.sessionManager);
	if (!freshTargetId) {
		if (ctx.hasUI) ctx.ui.notify("No starting point found.", "warning");
		return null;
	}

	const navResult = await ctx.navigateTree(freshTargetId, {
		summarize: false,
	});
	if (navResult.cancelled) {
		if (ctx.hasUI) ctx.ui.notify("Navigation cancelled.", "warning");
		return null;
	}

	return { departureLeafId, freshTargetId };
}

async function beginStageTransition(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
	message: string,
	entryType: "ped-stage-start" | "ped-stage-reload" = "ped-stage-start",
	entryPrompt?: string,
): Promise<boolean> {
	rememberCommandContext(ctx);

	const nav = await prepareStageNavigation(ctx);
	if (!nav) return false;

	// Navigation is the commit point for a stage transition. Do not advertise
	// the target stage to guards/reload until the new context actually exists.
	await activateStage(ctx.cwd, stageKey);

	pi.appendEntry(entryType, {
		returnTo: nav.departureLeafId,
		stage: stageKey,
		...(entryPrompt ? { prompt: entryPrompt } : {}),
	});

	await switchStageConfig(pi, ctx, stageKey, entryPrompt);
	setPendingSkillPath(computeSkillPath(stageKey));
	pi.sendUserMessage(message);
	return true;
}

export async function startStageFromRememberedContext(
	pi: ExtensionAPI,
	stageKey: PipelineStageKey,
	optionalPrompt?: string,
): Promise<boolean> {
	const ctx = rememberedCommandContext;
	if (!ctx) return false;

	let resolvedStage = stageKey;
	let entryPrompt = optionalPrompt;
	const state = await createWorkflowStateTool().execute({ repoRoot: ctx.cwd });
	const reviewNext = await resolveReviewNextRoute(ctx.cwd, state);
	if (!reviewNext.ok) {
		if (ctx.hasUI) ctx.ui.notify(reviewNext.blocker, "warning");
		return false;
	}
	if (reviewNext.route) {
		resolvedStage = reviewNext.route.stage;
		entryPrompt ??= reviewFixForwardPrompt(reviewNext.route);
		if (ctx.hasUI && stageKey !== resolvedStage) {
			ctx.ui.notify(
				`Review outcome overrides queued auto-advance: ${stageKey} -> ${resolvedStage}`,
				"info",
			);
		}
	}

	return beginStageTransition(
		pi,
		ctx,
		resolvedStage,
		entryPrompt || `Stage: ${resolvedStage}`,
		"ped-stage-start",
		entryPrompt,
	);
}

/**
 * Re-enter the currently active stage after a persisted enforcing gate
 * escalation. Called only once the model turn has ended; never navigate
 * the session tree while a tool call is executing.
 */
export async function autoReloadEscalatedStage(
	pi: ExtensionAPI,
	repoRoot: string,
	stageKey: PipelineStageKey,
): Promise<boolean> {
	const ctx = rememberedCommandContext;
	if (!ctx || ctx.cwd !== repoRoot) return false;
	const active = await resolveReloadStage(repoRoot);
	if (active !== stageKey) return false;
	return beginStageTransition(
		pi,
		ctx,
		stageKey,
		`Stage gate requested SOTA escalation for ${stageKey}. Restart this stage under the configured SOTA model; follow the stage skill from the beginning and revalidate the artifact.`,
		"ped-stage-reload",
	);
}

// ── Abort handler (shared between commands) ────────────────────────

/** Format err for user-facing messages without leaking stack traces. */
function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Handle abort cases from stage resolution.
 * Returns true if an abort occurred (caller should return).
 */
async function handleResolutionAbort(
	ctx: ExtensionCommandContext,
	resolution: Extract<StageResolution, { ok: false }>,
): Promise<boolean> {
	if (resolution.reason === "critical_health") {
		try {
			const handoffTool = createContextHandoffTool();
			await handoffTool.execute({
				operation: "save",
				repoRoot: ctx.cwd,
				currentStage: resolution.details.currentStage,
				// Critical-health abort is a same-stage checkpoint, never gated.
				nextStage: resolution.details.currentStage,
			});
		} catch (err) {
			if (ctx.hasUI)
				ctx.ui.notify(
					`Failed to save context handoff: ${formatError(err)}`,
					"error",
				);
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Session context critically inflated. Run `/ped-start <prompt>` in a new session.",
				"warning",
			);
		}
		return true;
	}

	if (resolution.reason === "blocker") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Blocker exists in stage ${resolution.details.currentStage}: ${resolution.details.blocker}`,
				"warning",
			);
		}
		return true;
	}

	if (resolution.reason === "new_session_recommended") {
		const p = `Continue this pi-pedstack workflow, do not restart.\nRepo: ${ctx.cwd}\nPlease read first:\n- Latest handoff: ${resolution.details.latestHandoffPath}\nThen continue:\n- /ped-next`;
		if (ctx.hasUI)
			ctx.ui.notify(
				`New session recommended for ${resolution.details.nextStage}. Copyable prompt:\n${p}`,
				"info",
			);
		return true;
	}

	// ambiguous
	if (ctx.hasUI)
		ctx.ui.notify(
			"Could not determine next pipeline stage. Try /ped-start <prompt> to begin.",
			"warning",
		);
	return true;
}

// ── /ped-start command ─────────────────────────────────────────────

/**
 * Command factory for `/ped-start <prompt>`.
 *
 * Marks the root of a new Pedstack workflow, navigates to a fresh context,
 * applies model/thinking/APPEND.md config, and sends the user's prompt
 * as the initial message for 01-brainstorm.
 */
export function cmdPedStart(
	pi: ExtensionAPI,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	return {
		description: "Start a new Pedstack workflow. Usage: /ped-start <prompt>",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const prompt = _args.trim();
			if (!prompt) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Prompt required. Usage: /ped-start <prompt>",
						"warning",
					);
				}
				return;
			}

			rememberCommandContext(ctx);
			const nav = await prepareStageNavigation(ctx);
			if (!nav) return;

			if (!(await resetWorkflowScopedState(ctx))) return;
			await resetDiagnosticWorkflow();

			const stageKey: PipelineStageKey = "01-brainstorm";
			await activateStage(ctx.cwd, stageKey);

			pi.appendEntry("ped-workflow-start", {
				anchorLeafId: nav.departureLeafId,
			});

			pi.appendEntry("ped-stage-start", {
				returnTo: nav.departureLeafId,
				stage: stageKey,
			});

			await switchStageConfig(pi, ctx, stageKey, prompt);

			// Store the skill path for the model to read itself — clean UX, no content injection
			setPendingSkillPath(computeSkillPath(stageKey));
			pi.sendUserMessage(prompt);
		},
	};
}

interface ReviewNextRoute {
	stage: "03-work" | "05-learn";
	reportPath: string;
	legacyInferred: boolean;
}

type ReviewNextResolution =
	| { ok: true; route: ReviewNextRoute | null }
	| { ok: false; blocker: string };

function normalizeReviewReportPath(
	repoRoot: string,
	candidate: string | undefined,
): { absolute: string; relative: string } | null {
	if (!candidate) return null;
	const absolute = path.resolve(repoRoot, candidate);
	const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
	if (
		relative.startsWith("../") ||
		path.isAbsolute(relative) ||
		!relative.startsWith("docs/reviews/") ||
		!relative.endsWith(".md")
	) {
		return null;
	}
	return { absolute, relative };
}

/**
 * Revalidate a completed 04-review at transition time.
 *
 * PR #47 made new handoff saves outcome-aware, but an already-saved/stale
 * `04-review -> 05-learn` handoff can predate that contract. /ped-next and
 * same-session auto-advance must therefore derive the destination from the
 * review report instead of blindly trusting persisted nextStage.
 */
async function resolveReviewNextRoute(
	repoRoot: string,
	state: WorkflowStateResult,
): Promise<ReviewNextResolution> {
	if (state.context.currentStage !== "04-review") {
		return { ok: true, route: null };
	}

	const artifactCandidate = normalizeReviewReportPath(
		repoRoot,
		state.context.artifacts?.review,
	);
	const latestCandidate = normalizeReviewReportPath(
		repoRoot,
		state.reviews.latest
			? path.join("docs", "reviews", state.reviews.latest)
			: undefined,
	);
	const candidate = artifactCandidate ?? latestCandidate;
	if (!candidate) {
		return {
			ok: false,
			blocker:
				"Cannot advance from 04-review: no compiled docs/reviews/*.md report is available to validate the review outcome. Run /ped-reload and complete 04-review again.",
		};
	}

	let markdown: string;
	try {
		markdown = await readFile(candidate.absolute, "utf8");
	} catch {
		return {
			ok: false,
			blocker:
				`Cannot advance from 04-review: review report "${candidate.relative}" could not be read. Run /ped-reload and complete 04-review again.`,
		};
	}

	const outcome = parseReviewOutcome(markdown);
	if (outcome.valid) {
		return {
			ok: true,
			route: {
				stage: requiredNextStageForReview(outcome),
				reportPath: candidate.relative,
				legacyInferred: false,
			},
		};
	}

	// Backward compatibility only for reports created before Review Outcome
	// existed. A legacy report with explicit structured findings is safely
	// treated as unresolved; a legacy report with zero detectable findings is
	// ambiguous and must be re-reviewed rather than assumed clean.
	if (outcome.reason === 'missing "## Review Outcome" section') {
		const findings = countStructuredFindings(markdown);
		if (findings > 0) {
			return {
				ok: true,
				route: {
					stage: "03-work",
					reportPath: candidate.relative,
					legacyInferred: true,
				},
			};
		}
	}

	return {
		ok: false,
		blocker:
			`Cannot advance from 04-review: review report "${candidate.relative}" does not have a valid Review Outcome (${outcome.reason}). Run /ped-reload and complete 04-review again; Pedstack will not assume a stale 05-learn route is safe.`,
	};
}

function withValidatedReviewNextStage(
	state: WorkflowStateResult,
	route: ReviewNextRoute | null,
): WorkflowStateResult {
	if (!route) return state;
	return {
		...state,
		context: {
			...state.context,
			nextStage: route.stage,
		},
	};
}

function reviewFixForwardPrompt(route: ReviewNextRoute): string | undefined {
	if (route.stage !== "03-work") return undefined;
	return (
		`Fix the unresolved review findings in ${route.reportPath}. ` +
		"This is a 04-review -> 03-work fix-forward re-entry. Verify each finding against current code, fix every confirmed issue with targeted regression coverage, then return to 04-review."
	);
}

// ── /ped-next command ──────────────────────────────────────────────

/**
 * Command factory for `/ped-next [optional prompt]`.
 *
 * Auto-resolves the next pipeline stage via recommendation-logic.md,
 * navigates to a fresh context, applies config, and invokes the resolved skill.
 * Optional prompt is sent as a separate followUp message.
 */
export function cmdPedNext(
	pi: ExtensionAPI,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	return {
		description:
			"Advance to the next pipeline stage. Usage: /ped-next [optional prompt]",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			rememberCommandContext(ctx);

			let state: WorkflowStateResult;
			try {
				state = await createWorkflowStateTool().execute({ repoRoot: ctx.cwd });
			} catch (err) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Failed to read workflow state: ${formatError(err)}`,
						"error",
					);
				return;
			}

			// Preserve resolver priorities 1-2 before review-route recovery.
			if (
				state.context.contextHealth === "critical" ||
				(state.context.blocker && state.context.blocker !== "N/A")
			) {
				const blocked = resolveNextPipelineStage(state);
				if (!blocked.ok) {
					await handleResolutionAbort(ctx, blocked);
					return;
				}
			}

			const reviewNext = await resolveReviewNextRoute(ctx.cwd, state);
			if (!reviewNext.ok) {
				if (ctx.hasUI) ctx.ui.notify(reviewNext.blocker, "warning");
				return;
			}
			const routedState = withValidatedReviewNextStage(state, reviewNext.route);
			const resolution = resolveNextPipelineStage(routedState);

			if (!resolution.ok) {
				await handleResolutionAbort(ctx, resolution);
				return;
			}

			const stageKey = resolution.stage;
			const optionalPrompt = _args.trim() || undefined;
			const reviewPrompt = reviewNext.route
				? reviewFixForwardPrompt(reviewNext.route)
				: undefined;
			const entryPrompt = optionalPrompt ?? reviewPrompt;

			if (
				ctx.hasUI &&
				reviewNext.route &&
				state.context.nextStage !== reviewNext.route.stage
			) {
				ctx.ui.notify(
					`Review outcome overrides stale handoff route: ${state.context.nextStage ?? "unset"} -> ${reviewNext.route.stage}` +
						(reviewNext.route.legacyInferred
							? " (legacy report with structured findings)"
							: ""),
					"info",
				);
			}

			await beginStageTransition(
				pi,
				ctx,
				stageKey,
				entryPrompt || `Stage: ${stageKey}`,
				"ped-stage-start",
				entryPrompt,
			);
		},
	};
}

// ── /ped-fix-issues command ────────────────────────────────────────

/**
 * Command factory for `/ped-fix-issues <numbers>`.
 *
 * Parses GitHub issue numbers, navigates to a fresh 01-brainstorm context,
 * sets pending skill path and fix-issues state, and sends a message that
 * instructs the agent to fetch issue content and brainstorm.
 */
export function cmdPedFixIssues(
	pi: ExtensionAPI,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	return {
		description:
			"Start a brainstorm with GitHub issues as context. " +
			"Usage: /ped-fix-issues <numbers>",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			rememberCommandContext(ctx);
			const parsedNumbers = parseIssueNumbers(_args);
			if (parsedNumbers.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"No valid issue numbers. Usage: /ped-fix-issues <numbers>",
						"warning",
					);
				}
				return;
			}

			// Warn if truncation occurred (pre-cap unique count exceeds 10)
			const rawSegments = _args
				.split(/\s+/)
				.map((s) => s.replace(/\D/g, ""))
				.filter(Boolean);
			const uniqueCount = [...new Set(rawSegments)].length;
			if (uniqueCount > 10 && ctx.hasUI) {
				ctx.ui.notify(
					`Truncated to 10 issues (${uniqueCount} provided).`,
					"warning",
				);
			}

			const nav = await prepareStageNavigation(ctx);
			if (!nav) return;

			if (!(await resetWorkflowScopedState(ctx))) return;
			await resetDiagnosticWorkflow();

			const stageKey: PipelineStageKey = "01-brainstorm";
			await activateStage(ctx.cwd, stageKey);

			pi.appendEntry("ped-workflow-start", {
				anchorLeafId: nav.departureLeafId,
			});
			pi.appendEntry("ped-stage-start", {
				returnTo: nav.departureLeafId,
				stage: stageKey,
			});
			try {
				await switchStageConfig(pi, ctx, stageKey);
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Config switch failed: ${formatError(err)}`, "error");
				}
				return;
			}
			setPendingSkillPath(computeSkillPath(stageKey));
			setPendingFixIssues(parsedNumbers);
			const formattedList = parsedNumbers.map((n) => `#${n}`).join(", ");
			try {
				pi.sendUserMessage(
					`Fetch GitHub issues ${formattedList} and brainstorm solutions.`,
				);
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Failed to start: ${formatError(err)}`, "error");
				}
			}
		},
	};
}

/** Read workflow state, returning null on failure with notification. */
async function readWorkflowState(
	ctx: ExtensionCommandContext,
): Promise<WorkflowStateResult | null> {
	try {
		return await createWorkflowStateTool().execute({ repoRoot: ctx.cwd });
	} catch (err) {
		if (ctx.hasUI)
			ctx.ui.notify(
				`Failed to read workflow state: ${formatError(err)}`,
				"error",
			);
		return null;
	}
}

/**
 * Check debug gating: only allows /ped-debug after 04-review handoff
 * to 05-learn (currentStage === "04-review" && nextStage === "05-learn").
 * All other states are blocked with a notification.
 */
function checkDebugGate(
	ctx: ExtensionCommandContext,
	currentStage: string | undefined,
	nextStage: string | undefined,
): boolean {
	if (!currentStage) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"No active workflow found. Start a workflow with /ped-start first.",
				"warning",
			);
		}
		return false;
	}

	if (
		(currentStage === "04-review" && nextStage === "05-learn") ||
		currentStage === "04-5-debug"
	) {
		return true;
	}

	if (ctx.hasUI) {
		ctx.ui.notify(
			"/ped-debug is only available after 04-review completes and before 05-learn begins. " +
				`Current workflow is at ${currentStage}` +
				(nextStage ? ` (next: ${nextStage})` : "") +
				".",
			"warning",
		);
	}
	return false;
}

// ── /ped-debug command ──────────────────────────────────────────────

/**
 * Command factory for `/ped-debug <prompt>`.
 *
 * Enters the 04-5-debug stage on demand with gating logic:
 * - Blocks if no workflow state exists.
 * - Blocks unless at exactly 04-review with nextStage 05-learn.
 * - Blocks if no prompt argument is provided.
 * Navigates to fresh context, applies debug stage config, and invokes the skill.
 */
export function cmdPedDebug(
	pi: ExtensionAPI,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	return {
		description: "Enter the debug stage on demand. Usage: /ped-debug <prompt>",
		// ponytail: handler duplicated from cmdPedFixIssues pattern to avoid
		// premature abstraction — same nav/config/message shape, different gating.
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			rememberCommandContext(ctx);

			const prompt = _args.trim();
			if (!prompt) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"A prompt is required. Usage: /ped-debug <prompt>",
						"warning",
					);
				}
				return;
			}

			const state = await readWorkflowState(ctx);
			if (!state) return;

			const { currentStage, nextStage } = state.context;
			if (!checkDebugGate(ctx, currentStage, nextStage)) return;

			const stageKey: PipelineStageKey = "04-5-debug";

			try {
				await beginStageTransition(
					pi,
					ctx,
					stageKey,
					prompt,
					"ped-stage-start",
					prompt,
				);
			} catch (err) {
				if (ctx.hasUI)
					ctx.ui.notify(`Config switch failed: ${formatError(err)}`, "error");
			}
		},
	};
}

/**
 * Resolve the stage that /ped-reload should restart.
 *
 * The active-stage store represents the stage executing right now, while
 * context-state.currentStage represents the latest durable handoff and may
 * legitimately lag during an in-progress stage. Prefer live memory, then the
 * persisted active-stage side file for process/session resume, and use the
 * handoff state only as a compatibility fallback.
 */
async function resolveReloadStage(repoRoot: string): Promise<PipelineStageKey | null> {
	const memoryStage = getActiveStage();
	if (memoryStage && isValidStageKey(memoryStage)) return memoryStage;

	const persistedStage = await readPersistedActiveStage(repoRoot);
	if (persistedStage && isValidStageKey(persistedStage)) return persistedStage;

	const state = await createWorkflowStateTool().execute({ repoRoot });
	const handoffStage = state.context.currentStage;
	return handoffStage && isValidStageKey(handoffStage) ? handoffStage : null;
}

// ── /ped-reload command ────────────────────────────────────────────

/**
 * Command factory for `/ped-reload`.
 *
 * Restarts the actually active stage cleanly: fresh context branch,
 * re-applied skill config (model/thinking/APPEND.md), and a clean skill prompt.
 * Active-stage memory/persistence is authoritative; workflow handoff state is
 * only a fallback because it can lag while a stage is still in progress.
 * Falls back to 01-brainstorm if no valid stage exists.
 */
export function cmdPedReload(
	pi: ExtensionAPI,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	return {
		description:
			"Restart the current pipeline stage cleanly. Usage: /ped-reload",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			rememberCommandContext(ctx);

			const optionalPrompt = args.trim() || undefined;

			let stageKey: PipelineStageKey;
			try {
				const resolved = await resolveReloadStage(ctx.cwd);
				if (resolved) {
					stageKey = resolved;
				} else {
					stageKey = "01-brainstorm";
					if (ctx.hasUI) {
						ctx.ui.notify(
							"No active stage found; starting 01-brainstorm.",
							"info",
						);
					}
				}
			} catch (err) {
				stageKey = "01-brainstorm";
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Could not resolve active stage: ${formatError(err)}. Falling back to 01-brainstorm.`,
						"warning",
					);
				}
			}

			await beginStageTransition(
				pi,
				ctx,
				stageKey,
				optionalPrompt ||
					`Reloading stage: ${stageKey}. Restart this stage clean — follow the skill instructions from scratch.`,
				"ped-stage-reload",
				optionalPrompt,
			);
		},
	};
}
