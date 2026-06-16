import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";

import {
	readPiPedstackConfig,
	getConfigKeyForSkill,
} from "../utils/config-types";
import { loadAllAppendContext, loadAppendContext } from "../utils/append-loader";
import { parseModelRef } from "../utils/parse-model-ref";
import {
	createWorkflowStateTool,
	type WorkflowStateResult,
} from "../tools/workflow-state";
import { createContextHandoffTool } from "../tools/context-handoff";

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

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
): Promise<void> {
	if (!stepConfig.model) return;

	const parsed = parseModelRef(stepConfig.model, ctx.model?.provider);
	if (!parsed) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Invalid model for ${stageKey}: ${stepConfig.model}`,
				"warning",
			);
		}
		return;
	}

	if (ctx.model?.provider === parsed.provider && ctx.model?.id === parsed.id) {
		return;
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Model not found for ${stageKey}: ${stepConfig.model}`,
				"warning",
			);
		}
		return;
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
		THINKING_LEVEL_MAP[stepConfig.thinkingLevel.toLowerCase()] ?? "medium";
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
		combined = allContent + "\n\n" + stageContent;
	} else if (allContent) {
		combined = allContent;
	} else if (stageContent) {
		combined = stageContent;
	}

	if (combined) {
		setPendingAppendContent(combined);
		if (ctx.hasUI) {
			const label = `${stageKey}` + (allContent ? " + ALL" : "");
			ctx.ui.notify(`Loaded APPEND.md context for ${label}`, "info");
		}
	}
}

/** Orchestrate model, thinking, and APPEND.md switching for a pipeline stage. */
async function switchStageConfig(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stageKey: PipelineStageKey,
): Promise<void> {
	const config = await readPiPedstackConfig(ctx.cwd);
	const configKey = getConfigKeyForSkill(stageKey);
	const stepConfig = configKey ? config?.[configKey] : null;

	await switchModel(pi, ctx, stageKey, stepConfig ?? {});
	switchThinkingLevel(pi, ctx, stageKey, stepConfig ?? {});
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
		const p = `Continue this pi-pedstack workflow, do not restart.\nRepo: ${ctx.cwd}\nPlease read first:\n- Latest handoff: ${resolution.details.latestHandoffPath}\nThen continue:\n- /skill:${resolution.details.nextStage}`;
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

			const nav = await prepareStageNavigation(ctx);
			if (!nav) return;

			pi.appendEntry("ped-workflow-start", {
				anchorLeafId: nav.departureLeafId,
			});

			const stageKey: PipelineStageKey = "01-brainstorm";
			pi.appendEntry("ped-stage-start", {
				returnTo: nav.departureLeafId,
				stage: stageKey,
			});

			await switchStageConfig(pi, ctx, stageKey);

			// Store the skill path for the model to read itself — clean UX, no content injection
			setPendingSkillPath(computeSkillPath(stageKey));
			pi.sendUserMessage(prompt);
		},
	};
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

			const resolution = resolveNextPipelineStage(state);

			if (!resolution.ok) {
				await handleResolutionAbort(ctx, resolution);
				return;
			}

			const stageKey = resolution.stage;
			const optionalPrompt = _args.trim() || undefined;

			const nav = await prepareStageNavigation(ctx);
			if (!nav) return;

			pi.appendEntry("ped-stage-start", {
				returnTo: nav.departureLeafId,
				stage: stageKey,
				prompt: optionalPrompt,
			});

			await switchStageConfig(pi, ctx, stageKey);

			// Store the skill path for the model to read itself — clean UX, no content injection
			setPendingSkillPath(computeSkillPath(stageKey));
			pi.sendUserMessage(optionalPrompt || "Stage: " + stageKey);
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
			pi.appendEntry("ped-workflow-start", {
				anchorLeafId: nav.departureLeafId,
			});
			const stageKey: PipelineStageKey = "01-brainstorm";
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
			const formattedList = parsedNumbers.map((n) => "#" + n).join(", ");
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
