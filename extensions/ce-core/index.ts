import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createArtifactHelperTool,
	type ArtifactType,
} from "./tools/artifact-helper";
import {
	cmdPedStart,
	cmdPedNext,
	cmdPedFixIssues,
	cmdPedReload,
	cmdPedDebug,
	initSkillRegistry,
	getAndClearPendingSkillPath,
	getAndClearPendingFixIssues,
	isValidStageKey,
	startStageFromRememberedContext,
	clearRememberedCommandContext,
	type PipelineStageKey,
} from "./commands/pedstack";
import { buildSystemPromptAppend } from "./commands/prompt-inject";
import {
	buildSolutionsAppend,
	composeSolutionSystemPrompt,
	registerSolutionSearch,
} from "./utils/solution-wiring";
import { registerSemanticTools } from "./utils/semantic-wiring";
import { createReviewRouterTool } from "./tools/review-router";
import { createSessionCheckpointTool } from "./tools/session-checkpoint";
import { createTaskSplitterTool } from "./tools/task-splitter";
import { createBrainstormDialogTool } from "./tools/brainstorm-dialog";
import { createPlanDiffTool } from "./tools/plan-diff";
import { createSessionHistoryTool } from "./tools/session-history";
import { createPatternExtractorTool } from "./tools/pattern-extractor";
import { createContextHandoffTool } from "./tools/context-handoff";
import { createStageGateTool, stageGateParams } from "./tools/stage-gate";
import { resolveStageGateMode } from "./stage-gate/store";
import {
	resolveReadinessFailClosed,
	resolveReadinessMode,
} from "./handoff-readiness/store";
import { filterBashOutput } from "./tools/bash-output-filter";
import { filterReadOutput } from "./tools/read-output-filter";
import { registerInjectionScreen } from "./injection-screen/handlers";
import { runFailureTriage } from "./tools/failure-triage-runner";
import type { PersistedTriage } from "./tools/triage-store";
import { COMPACTION_FOCUS_INSTRUCTIONS } from "./tools/compaction-optimizer";
import { createMultiReviewerTool } from "./tools/multi-reviewer";
import { createWorkflowStateTool } from "./tools/workflow-state";
import {
	createChecklistAddTool,
	createChecklistShowTool,
	createChecklistDelTool,
} from "./tools/checklist";
import {
	evaluateAutoAdvance,
	isAuthorized,
	markAuthorized,
	isGatedTransition,
	getConfirmDialog,
} from "./utils/auto-advance";
import {
	clearActiveStage,
	getActiveStage,
	readPersistedActiveStage,
} from "./utils/active-stage";
import { evaluateWrite } from "./utils/capability-matrix";
import { parseGuardMode } from "./utils/semantic-stage-guard";
import {
	createStageGuard,
	type StageGuard,
} from "./utils/stage-guard-runtime";
import { createJevRuntime } from "./jev/runtime";
import type { JevRuntime } from "./jev/types";

const artifactHelperParams = Type.Object({
	repoRoot: Type.String({
		description: "Repository root where workflow artifacts should be created",
	}),
	artifactType: Type.Union(
		[
			Type.Literal("brainstorm"),
			Type.Literal("plan"),
			Type.Literal("solution"),
			Type.Literal("run"),
		],
		{ description: "Artifact type to resolve" },
	),
	date: Type.Optional(
		Type.String({ description: "Date prefix for dated artifacts" }),
	),
	topic: Type.Optional(
		Type.String({ description: "Topic or slug source for the artifact" }),
	),
	category: Type.Optional(
		Type.String({ description: "Solution category for docs/solutions" }),
	),
	skillName: Type.Optional(
		Type.String({ description: "Skill name for run artifacts" }),
	),
	runId: Type.Optional(
		Type.String({ description: "Run identifier for runtime artifacts" }),
	),
	ensureDir: Type.Optional(
		Type.Boolean({ description: "Create the parent directory when true" }),
	),
});

const workflowStateParams = Type.Object({
	repoRoot: Type.String({
		description: "Repository root to scan for workflow artifacts",
	}),
});

const reviewRouterParams = Type.Object({
	filesChanged: Type.Array(Type.String(), {
		description: "List of file paths changed in the diff",
	}),
	insertions: Type.Number({ description: "Number of lines added" }),
	deletions: Type.Number({ description: "Number of lines removed" }),
});

const sessionCheckpointParams = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("save"),
			Type.Literal("load"),
			Type.Literal("list"),
			Type.Literal("fail"),
			Type.Literal("retry"),
		],
		{ description: "Checkpoint operation" },
	),
	repoRoot: Type.String({ description: "Repository root" }),
	planPath: Type.Optional(Type.String({ description: "Plan artifact path" })),
	completedUnits: Type.Optional(
		Type.Array(Type.String(), {
			description: "List of completed implementation unit names",
		}),
	),
	failedUnit: Type.Optional(
		Type.String({ description: "Name of the unit that failed" }),
	),
	error: Type.Optional(
		Type.String({ description: "Error message from the failure" }),
	),
});

const splitterUnitSchema = Type.Object({
	name: Type.String({ description: "Implementation unit name" }),
	files: Type.Array(Type.String(), { description: "Files this unit touches" }),
});

const taskSplitterParams = Type.Object({
	units: Type.Array(splitterUnitSchema, {
		description: "Implementation units to analyze for dependencies",
	}),
});

const brainstormDialogParams = Type.Object({
	operation: Type.Union(
		[Type.Literal("start"), Type.Literal("refine"), Type.Literal("summarize")],
		{ description: "Dialog operation" },
	),
	repoRoot: Type.String({ description: "Repository root" }),
	artifactPath: Type.String({ description: "Brainstorm artifact path" }),
	analysis: Type.Optional(
		Type.String({ description: "Agent's current analysis" }),
	),
	questions: Type.Optional(
		Type.Array(Type.String(), { description: "Open questions for the user" }),
	),
	userResponses: Type.Optional(
		Type.Array(Type.String(), {
			description: "User's answers from previous round",
		}),
	),
});

const planUnitSchema = Type.Object({
	name: Type.String({ description: "Unit name" }),
	description: Type.String({ description: "Unit description" }),
	files: Type.Array(Type.String(), { description: "Files this unit touches" }),
});

const planChangeSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("remove"), Type.Literal("modify")],
		{ description: "Change action" },
	),
	name: Type.String({ description: "Unit name" }),
	description: Type.Optional(
		Type.String({ description: "Updated description" }),
	),
	files: Type.Optional(
		Type.Array(Type.String(), { description: "Updated file list" }),
	),
});

const planDiffParams = Type.Object({
	operation: Type.Union([Type.Literal("compare"), Type.Literal("patch")], {
		description: "Diff operation",
	}),
	existingUnits: Type.Array(planUnitSchema, {
		description: "Current plan units",
	}),
	newRequirements: Type.Optional(
		Type.Array(planUnitSchema, {
			description: "Updated requirements for compare",
		}),
	),
	changes: Type.Optional(
		Type.Array(planChangeSchema, { description: "Changes to apply for patch" }),
	),
});

const sessionHistoryParams = Type.Object({
	operation: Type.Union(
		[Type.Literal("record"), Type.Literal("query"), Type.Literal("latest")],
		{ description: "History operation" },
	),
	repoRoot: Type.String({ description: "Repository root" }),
	skill: Type.Optional(
		Type.String({ description: "Skill name to filter or record" }),
	),
	artifactPath: Type.Optional(Type.String({ description: "Artifact path" })),
	summary: Type.Optional(Type.String({ description: "Execution summary" })),
});

const artifactInputSchema = Type.Object({
	path: Type.String({ description: "Artifact path" }),
	content: Type.String({ description: "Artifact content" }),
});

const patternSchema = Type.Object({
	keyword: Type.String({ description: "Pattern keyword" }),
	occurrences: Type.Number({ description: "Number of occurrences" }),
	sources: Type.Array(Type.String(), { description: "Artifact sources" }),
});

const contextHandoffParams = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("save"),
			Type.Literal("load"),
			Type.Literal("latest"),
			Type.Literal("status"),
			Type.Literal("validate"),
		],
		{ description: "Handoff operation" },
	),
	repoRoot: Type.String({ description: "Repository root" }),
	currentStage: Type.Optional(
		Type.String({ description: "Current pipeline stage (e.g. 02-plan)" }),
	),
	nextStage: Type.Optional(Type.String({ description: "Next pipeline stage" })),
	contextHealth: Type.Optional(
		Type.Union(
			[
				Type.Literal("good"),
				Type.Literal("watch"),
				Type.Literal("heavy"),
				Type.Literal("critical"),
			],
			{ description: "Context health assessment" },
		),
	),
	activeFiles: Type.Optional(
		Type.Array(Type.String(), {
			description: "1-5 must-know active file paths",
		}),
	),
	blocker: Type.Optional(
		Type.String({ description: "Current blocker description" }),
	),
	verification: Type.Optional(
		Type.String({ description: "Latest verification command + result" }),
	),
	artifacts: Type.Optional(
		Type.Record(Type.String(), Type.Optional(Type.String()), {
			description: "Artifact paths (requirements, plan, checkpoint, proof)",
		}),
	),
	handoffMarkdown: Type.Optional(
		Type.String({ description: "Custom handoff markdown content" }),
	),
	handoffPath: Type.Optional(
		Type.String({ description: "Specific handoff file path to load" }),
	),
	currentTruth: Type.Optional(
		Type.Array(Type.String(), {
			description: "Known true statements validated during session",
		}),
	),
	invalidatedAssumptions: Type.Optional(
		Type.Array(Type.String(), {
			description: "Assumptions proven wrong during session",
		}),
	),
	openDecisions: Type.Optional(
		Type.Array(Type.String(), {
			description: "Pending decisions that affect next steps",
		}),
	),
	recentlyAccessedFiles: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files recently read or edited (defaults to activeFiles)",
		}),
	),
	compressionRisk: Type.Optional(
		Type.Array(Type.String(), {
			description: "Context compression risks to watch for",
		}),
	),
	activeRules: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"1-5 must-know rules for continuation (TDD gates, constraints, do-not-repeat)",
		}),
	),
});

const checklistAddParams = Type.Object({
	descriptions: Type.Array(Type.String(), {
		description:
			"Task descriptions to add — pass one or more items to create them all at once",
	}),
});

const checklistShowParams = Type.Object({});

const checklistDelParams = Type.Object({
	indexes: Type.Array(Type.Integer(), {
		description: "1-based indexes of tasks to remove",
	}),
});

const multiReviewerParams = Type.Object({
	stepName: Type.String({ description: "Pipeline step name" }),
	primaryOutput: Type.String({
		description: "Code changes or output to review",
	}),
	repoRoot: Type.String({ description: "Repository root path" }),
});

const patternExtractorParams = Type.Object({
	operation: Type.Union([Type.Literal("extract"), Type.Literal("categorize")], {
		description: "Pattern operation",
	}),
	artifacts: Type.Optional(
		Type.Array(artifactInputSchema, { description: "Artifacts to analyze" }),
	),
	keywords: Type.Optional(
		Type.Array(Type.String(), { description: "Keywords to search for" }),
	),
	patterns: Type.Optional(
		Type.Array(patternSchema, { description: "Patterns to categorize" }),
	),
	categories: Type.Optional(
		Type.Record(Type.String(), Type.Array(Type.String()), {
			description: "Category name to keyword mapping",
		}),
	),
});

// Test seam: allows tests to inject a fake Jev runtime without spawning `cmd`.
let stageGuardJevFactory: (() => JevRuntime) | null = null;

/** @internal Test-only injection seam for the Jev runtime. */
export function __setStageGuardJevFactory(
	factory: (() => JevRuntime) | null,
): void {
	stageGuardJevFactory = factory;
}

export default function ceCoreExtension(pi: ExtensionAPI) {
	const artifactHelper = createArtifactHelperTool();
	const workflowState = createWorkflowStateTool();
	const reviewRouter = createReviewRouterTool();
	const sessionCheckpoint = createSessionCheckpointTool();
	const taskSplitter = createTaskSplitterTool();
	const brainstormDialog = createBrainstormDialogTool();
	const planDiff = createPlanDiffTool();
	const sessionHistory = createSessionHistoryTool();
	const patternExtractor = createPatternExtractorTool();
	// ponytail: operator-only gate mode, resolved once at init like the guard.
	const gateMode = resolveStageGateMode(process.env);
	// ponytail: handoff-readiness mode/fail-closed are also resolved once.
	const contextHandoff = createContextHandoffTool({
		gateMode,
		readiness: {
			mode: resolveReadinessMode(process.env),
			failClosed: resolveReadinessFailClosed(process.env),
		},
	});
	const stageGate = createStageGateTool({ mode: gateMode });
	const multiReviewer = createMultiReviewerTool();
	const checklistAdd = createChecklistAddTool();
	const checklistShow = createChecklistShowTool();
	const checklistDel = createChecklistDelTool();
	let pendingAutoAdvance: {
		stageKey: PipelineStageKey;
		stagePair: string | null;
		isGated: boolean;
	} | null = null;

	// ponytail: Operator escape hatch, read once at init. Any read error keeps
	// the guard enforced (the `!== "1"` comparison cannot throw).
	const guardDisabled = process.env.PEDSTACK_DISABLE_GUARD === "1";
	let persistedStageResolved = false;
	let persistedStage: string | null = null;
	let guardNotified = false;

	// ponytail: Jev runtime created once, lazily; no process spawns until decide().
	let jevRuntime: ReturnType<typeof createJevRuntime> | null = null;
	function getJevRuntime() {
		jevRuntime ??= createJevRuntime();
		return jevRuntime;
	}

	// ponytail: Jev stage guard config, read once at init. Invalid values fail
	// safe to shadow; the warning is deferred to the first tool call (no ctx yet).
	const guardModeRaw = process.env.PEDSTACK_JEV_STAGE_GUARD;
	const guardMode = parseGuardMode(guardModeRaw);
	const guardModeInvalid =
		guardModeRaw !== undefined &&
		guardModeRaw !== "off" &&
		guardModeRaw !== "shadow" &&
		guardModeRaw !== "enforce";
	const guardFailClosed =
		process.env.PEDSTACK_JEV_STAGE_GUARD_FAILCLOSED === "1";
	let guardModeNotified = false;
	let stageGuard: StageGuard | null = null;

	pi.registerTool({
		name: artifactHelper.name,
		label: "Artifact Helper",
		description:
			"Resolve and optionally create standard Compound Engineering artifact paths.",
		parameters: artifactHelperParams,
		async execute(_toolCallId, params) {
			const result = await artifactHelper.execute({
				repoRoot: params.repoRoot,
				artifactType: params.artifactType as ArtifactType,
				date: params.date,
				topic: params.topic,
				category: params.category,
				skillName: params.skillName,
				runId: params.runId,
				ensureDir: params.ensureDir,
			});

			return {
				content: [{ type: "text", text: result.path }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: workflowState.name,
		label: "Workflow State",
		description:
			"Scan repo-local Compound Engineering artifacts and return structured workflow state.",
		parameters: workflowStateParams,
		async execute(_toolCallId, params) {
			const result = await workflowState.execute({
				repoRoot: params.repoRoot,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: reviewRouter.name,
		label: "Review Router",
		description:
			"Analyze diff metadata and recommend reviewer personas for structured code review.",
		parameters: reviewRouterParams,
		async execute(_toolCallId, params) {
			const result = await reviewRouter.execute({
				filesChanged: params.filesChanged,
				insertions: params.insertions,
				deletions: params.deletions,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: sessionCheckpoint.name,
		label: "Session Checkpoint",
		description:
			"Save and load plan execution checkpoints for resume-from-checkpoint behavior.",
		parameters: sessionCheckpointParams,
		async execute(_toolCallId, params) {
			const result = await sessionCheckpoint.execute({
				operation: params.operation,
				repoRoot: params.repoRoot,
				planPath: params.planPath,
				completedUnits: params.completedUnits,
				failedUnit: params.failedUnit,
				error: params.error,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: taskSplitter.name,
		label: "Task Splitter",
		description:
			"Analyze implementation units for file-level dependencies and output parallel-safe execution groups.",
		parameters: taskSplitterParams,
		async execute(_toolCallId, params) {
			const result = taskSplitter.execute({
				units: params.units,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: brainstormDialog.name,
		label: "Brainstorm Dialog",
		description:
			"Manage multi-round brainstorm conversations with iterative refinement.",
		parameters: brainstormDialogParams,
		async execute(_toolCallId, params) {
			const result = await brainstormDialog.execute({
				operation: params.operation,
				repoRoot: params.repoRoot,
				artifactPath: params.artifactPath,
				analysis: params.analysis,
				questions: params.questions,
				userResponses: params.userResponses,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: planDiff.name,
		label: "Plan Diff",
		description:
			"Compare plan units with new requirements or apply incremental changes to an existing plan.",
		parameters: planDiffParams,
		async execute(_toolCallId, params) {
			const result = planDiff.execute({
				operation: params.operation,
				existingUnits: params.existingUnits,
				newRequirements: params.newRequirements,
				changes: params.changes,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: sessionHistory.name,
		label: "Session History",
		description: "Record and query CE skill execution history.",
		parameters: sessionHistoryParams,
		async execute(_toolCallId, params) {
			const result = await sessionHistory.execute({
				operation: params.operation,
				repoRoot: params.repoRoot,
				skill: params.skill,
				artifactPath: params.artifactPath,
				summary: params.summary,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: patternExtractor.name,
		label: "Pattern Extractor",
		description: "Extract and categorize recurring patterns from artifacts.",
		parameters: patternExtractorParams,
		async execute(_toolCallId, params) {
			const input: Record<string, unknown> = { operation: params.operation };
			if (params.artifacts) input.artifacts = params.artifacts;
			if (params.keywords) input.keywords = params.keywords;
			if (params.patterns) input.patterns = params.patterns;
			if (params.categories) input.categories = params.categories;

			const result = patternExtractor.execute(input as any);

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: contextHandoff.name,
		label: "Context Handoff",
		description:
			"Manage cross-stage context handoffs with evidence-first templates. Supports save (write handoff + state), load (read handoff + state), latest (read latest dated handoff), status (read current state), and validate (check continuation readiness with deterministic probes).",
		parameters: contextHandoffParams,
		async execute(_toolCallId, params) {
			const result = await contextHandoff.execute({
				operation: params.operation,
				repoRoot: params.repoRoot,
				currentStage: params.currentStage,
				nextStage: params.nextStage,
				contextHealth: params.contextHealth,
				activeFiles: params.activeFiles,
				blocker: params.blocker,
				verification: params.verification,
				artifacts: params.artifacts as
					| Record<string, string | undefined>
					| undefined,
				handoffMarkdown: params.handoffMarkdown,
				handoffPath: params.handoffPath,
				currentTruth: params.currentTruth,
				invalidatedAssumptions: params.invalidatedAssumptions,
				openDecisions: params.openDecisions,
				recentlyAccessedFiles: params.recentlyAccessedFiles,
				compressionRisk: params.compressionRisk,
				activeRules: params.activeRules,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: stageGate.name,
		label: "Stage Gate",
		description:
			"Score the artifact a stage produced: deterministic evidence checks first, bounded semantic scoring second, and one combined verdict (accept | revise | review | escalate).",
		parameters: stageGateParams,
		async execute(_toolCallId, params) {
			const result = await stageGate.execute({
				repoRoot: params.repoRoot,
				stage: params.stage,
				artifactPaths: params.artifactPaths,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: checklistAdd.name,
		label: "Checklist Add",
		description:
			"Add one or more tasks to the checklist in a single call. Use this when discovering tasks from skills, rules, or instructions.",
		parameters: checklistAddParams,
		async execute(_toolCallId, params) {
			const result = await checklistAdd.execute({
				descriptions: params.descriptions,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: checklistShow.name,
		label: "Checklist Show",
		description:
			"Show all pending checklist tasks. Returns items with 1-based indexes for use with checklist_del.",
		parameters: checklistShowParams,
		async execute(_toolCallId, params) {
			const result = await checklistShow.execute(
				params as Record<string, never>,
			);

			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: checklistDel.name,
		label: "Checklist Delete",
		description:
			"Remove completed or cancelled tasks from the checklist by 1-based index.",
		parameters: checklistDelParams,
		async execute(_toolCallId, params) {
			const result = await checklistDel.execute({
				indexes: params.indexes,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerCommand("ped-start", cmdPedStart(pi));
	pi.registerCommand("ped-next", cmdPedNext(pi));
	pi.registerCommand("ped-fix-issues", cmdPedFixIssues(pi));
	pi.registerCommand("ped-reload", cmdPedReload(pi));
	pi.registerCommand("ped-debug", cmdPedDebug(pi));

	// ponytail: Stage capability guard — blocks deterministic forbidden
	// `write`/`edit` calls before execution. Fail-open on anything it cannot
	// prove forbidden; docs are blocked in 03-work by this very matrix.

	/** Report a guard failure at most once per extension instance. */
	function notifyGuardFailureOnce(ctx: ExtensionContext, err: unknown): void {
		if (guardNotified) return;
		guardNotified = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Pedstack stage guard failed open: ${
					err instanceof Error ? err.message : String(err)
				}`,
				"warning",
			);
		}
	}

	/** Resolve the active stage from memory, falling back to the persisted file. */
	async function resolveGuardStage(
		ctx: ExtensionContext,
	): Promise<string | null> {
		const memoryStage = getActiveStage();
		if (memoryStage !== null) return memoryStage;

		if (!persistedStageResolved) {
			persistedStage = await readPersistedActiveStage(ctx.cwd);
			persistedStageResolved = true;
		}
		return persistedStage;
	}

	/** Lazily build the bash guard, memoizing the Jev runtime on first use. */
	function getStageGuard(): StageGuard {
		stageGuard ??= createStageGuard({
			mode: guardMode,
			failClosed: guardFailClosed,
			createJev: () =>
				stageGuardJevFactory ? stageGuardJevFactory() : createJevRuntime(),
		});
		return stageGuard;
	}

	/** Warn once when `PEDSTACK_JEV_STAGE_GUARD` is not a known mode. */
	function notifyInvalidGuardModeOnce(ctx: ExtensionContext): void {
		if (!guardModeInvalid || guardModeNotified) return;
		guardModeNotified = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Pedstack stage guard: invalid PEDSTACK_JEV_STAGE_GUARD value ` +
					`"${guardModeRaw}"; using shadow mode.`,
				"warning",
			);
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (guardDisabled) return undefined;

		try {
			notifyInvalidGuardModeOnce(ctx);

			if (event.toolName === "bash") {
				if (guardMode === "off") return undefined;
				const command = (event.input as { command?: unknown }).command;
				if (typeof command !== "string" || command.length === 0) {
					return undefined;
				}
				const bashStage = await resolveGuardStage(ctx);
				return await getStageGuard().evaluate({
					repoRoot: ctx.cwd,
					stage: bashStage,
					cwd: ctx.cwd,
					command,
					notify: (message: string) => {
						if (ctx.hasUI) ctx.ui.notify(message, "warning");
					},
				});
			}

			if (event.toolName !== "write" && event.toolName !== "edit") {
				return undefined;
			}

			const target = (event.input as { path?: unknown }).path;
			if (typeof target !== "string" || target.length === 0) {
				return undefined;
			}

			const stage = await resolveGuardStage(ctx);
			const verdict = evaluateWrite(stage, ctx.cwd, target);
			if (verdict.allow) return undefined;

			return { block: true, reason: verdict.reason };
		} catch (err) {
			// ponytail: never let a guard bug block unrelated tool calls.
			notifyGuardFailureOnce(ctx, err);
			return undefined;
		}
	});

	// Capture skills and inject pending skill path into system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.systemPromptOptions?.skills?.length) {
			initSkillRegistry(event.systemPromptOptions.skills);
		}

		const skillPath = getAndClearPendingSkillPath();
		const fixIssues = getAndClearPendingFixIssues();

		const append = buildSystemPromptAppend(skillPath, fixIssues);
		const solutionsBlock = ctx?.cwd
			? await buildSolutionsAppend({ repoRoot: ctx.cwd, skillPath })
			: undefined;
		return composeSolutionSystemPrompt(event.systemPrompt, append, solutionsBlock);
	});

	pi.registerTool({
		name: multiReviewer.name,
		label: "Multi Reviewer",
		description:
			"Orchestrate multiple reviewer subagents in parallel to review code output.",
		parameters: multiReviewerParams,
		async execute(_toolCallId, params) {
			const result = await multiReviewer.execute({
				stepName: params.stepName,
				primaryOutput: params.primaryOutput,
				repoRoot: params.repoRoot,
			});

			return {
				content: [{ type: "text", text: result.compiledSummary }],
				details: result,
			};
		},
	});

	// Semantic solution ranking: model-facing tool + auto-injection (one handler above).
	registerSolutionSearch(pi);

	// Injection screen phase 1 — screens raw untrusted results before the size
	// filters compress them (registered first; phase 2 below runs last).
	const injectionScreen = registerInjectionScreen(pi);

	// Cheap semantic file reads/scouting: model-facing tools over one engine.
	registerSemanticTools(pi);

	// Bash output smart filter — reduces context waste from verbose command output
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "bash") return undefined;

		// Extract command from input
		const command = (event.input as any)?.command ?? "";
		if (!command) return undefined;

		// Extract text content from tool result
		const textBlocks =
			(event.content as Array<any>)?.filter((b: any) => b.type === "text") ??
			[];
		if (textBlocks.length === 0) return undefined;

		const output = textBlocks.map((b: any) => b.text).join("");
		const fullOutputPath = (event.details as any)?.fullOutputPath;

		const result = filterBashOutput({
			command,
			output,
			isError: event.isError ?? false,
			fullOutputPath,
		});

		if (!result.filtered) return undefined;

		// Replace content with filtered version
		return {
			content: [{ type: "text", text: result.output }],
			details: {
				...(event.details && typeof event.details === "object"
					? event.details
					: {}),
				bashFilter: {
					strategy: result.strategy,
					originalBytes: result.originalBytes,
					filteredBytes: result.filteredBytes,
				},
			},
		};
	});

	// Read output smart filter — reduces context waste from large file reads
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "read") return undefined;

		// Extract path from input
		const path = (event.input as any)?.path ?? "";
		if (!path) return undefined;

		// Extract text content from tool result
		const textBlocks =
			(event.content as Array<any>)?.filter((b: any) => b.type === "text") ??
			[];
		if (textBlocks.length === 0) return undefined;

		const output = textBlocks.map((b: any) => b.text).join("");
		const isImage =
			(event.content as Array<any>)?.some((b: any) => b.type === "image") ??
			false;

		const result = filterReadOutput({
			path,
			output,
			isError: event.isError ?? false,
			isImage,
		});

		if (!result.filtered) return undefined;

		return {
			content: [{ type: "text", text: result.output }],
			details: {
				...(event.details && typeof event.details === "object"
					? event.details
					: {}),
				readFilter: {
					strategy: result.strategy,
					originalBytes: result.originalBytes,
					filteredBytes: result.filteredBytes,
				},
			},
		};
	});

	// Injection screen phase 2 — wraps final post-compression content when
	// enforce+flagged, plus the turn_end sweep and session_shutdown cleanup.
	injectionScreen.registerFinalPhase();

	// ponytail: Auto-advance handler — intercepts context_handoff save and queues
	// /ped-next for non-gated transitions. Additive to existing bash/read filters.
	//
	// Helpers extracted below to keep the handler callback under the 50-line limit.

	/** Extract the text content, next stage, and stage-pair key from a handoff save. */
	function extractSaveContent(event: any): {
		contentText: string;
		stagePair: string | null;
		nextStage: PipelineStageKey | null;
	} | null {
		const input = event.input as { operation?: string } | null;
		if (input?.operation !== "save") return null;

		const textBlocks =
			(event.content as Array<any>)?.filter((b: any) => b.type === "text") ??
			[];
		if (textBlocks.length === 0) return null;
		const contentText = textBlocks.map((b: any) => b.text).join("");

		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(contentText);
		} catch {
			return null;
		}

		const currentStage =
			typeof parsed?.currentStage === "string" ? parsed.currentStage : null;
		const nextStage =
			typeof parsed?.nextStage === "string" && isValidStageKey(parsed.nextStage)
				? parsed.nextStage
				: null;
		const stagePair =
			currentStage && nextStage ? `${currentStage}->${nextStage}` : null;

		return { contentText, stagePair, nextStage };
	}

	/**
	 * Queue an auto-advance for execution after agent_end.
	 *
	 * Unlike the original design, we do NOT show the confirm dialog here.
	 * The user should read the handoff summary first before being prompted,
	 * so the confirm dialog fires at agent_end time (via startAutoAdvanceWhenIdle)
	 * once the session is idle and the final response is visible.
	 */
	function queueAutoAdvanceVerdict(
		_verdict: ReturnType<typeof evaluateAutoAdvance>,
		saveContent: {
			stagePair: string | null;
			nextStage: PipelineStageKey | null;
		},
	): void {
		if (!saveContent.nextStage) return;

		const stagePair = saveContent.stagePair;
		pendingAutoAdvance = {
			stageKey: saveContent.nextStage,
			stagePair,
			isGated: stagePair ? isGatedTransition(stagePair) : false,
		};

		// No markAuthorized here — authorization happens only after the user confirms
		// the dialog that appears when the session becomes idle.
	}
	function startAutoAdvanceWhenIdle(
		ctx: ExtensionContext,
		queued: {
			stageKey: PipelineStageKey;
			stagePair: string | null;
			isGated: boolean;
		},
		retries = 20,
	): void {
		const attempt = () => {
			let idle = false;
			try {
				idle = ctx.isIdle();
			} catch {
				return;
			}

			if (!idle) {
				if (retries <= 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Auto-advance is still waiting for the previous turn to finish. Run /ped-next manually if it does not continue.",
							"warning",
						);
					}
					return;
				}
				retries -= 1;
				setTimeout(attempt, 0);
				return;
			}

			async function tryStart(): Promise<void> {
				// Gated transitions: show confirm after the summary is on screen
				if (
					queued.isGated &&
					queued.stagePair &&
					!isAuthorized(queued.stagePair)
				) {
					const dialog = getConfirmDialog(queued.stagePair);
					if (dialog) {
						let ok = false;
						try {
							ok = await ctx.ui.confirm(dialog.title, dialog.message);
						} catch {
							return;
						}
						if (!ok) return;
						markAuthorized(queued.stagePair);
					}
				}

				try {
					const started = await startStageFromRememberedContext(
						pi,
						queued.stageKey,
					);
					if (!started && ctx.hasUI) {
						ctx.ui.notify(
							"Auto-advance is queued but no live workflow command context is available. Run /ped-next manually.",
							"warning",
						);
					}
				} catch (err) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Auto-advance failed: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
				}
			}

			void tryStart();
		};

		setTimeout(attempt, 0);
	}

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "context_handoff") return undefined;

		try {
			const saveContent = extractSaveContent(event);
			if (!saveContent) return undefined;

			const verdict = evaluateAutoAdvance({
				toolName: event.toolName,
				input: event.input as { operation?: string } | null,
				contentText: saveContent.contentText,
				isError: event.isError ?? false,
				hasUI: ctx.hasUI,
				isAuthorized: saveContent.stagePair
					? isAuthorized(saveContent.stagePair)
					: false,
			});

			queueAutoAdvanceVerdict(verdict, saveContent);
		} catch (err) {
			// ponytail: never let auto-advance bugs break the handoff save
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto-advance failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
		return undefined;
	});

	// ponytail: failure triage handler — annotates failed verification commands
	// with an advisory TRIAGE block. Additive, fail-open, never returns isError.
	function extractTextContent(content: unknown): string | null {
		const blocks =
			(content as Array<{ type?: string; text?: string }> | undefined)?.filter(
				(block) => block.type === "text",
			) ?? [];
		const text = blocks.map((block) => block.text ?? "").join("");
		return text.length === 0 ? null : text;
	}

	function buildTriageDetails(
		base: unknown,
		captured: { record: PersistedTriage | null; persistError?: string },
	): Record<string, unknown> {
		return {
			...(base && typeof base === "object" ? base : {}),
			triage: {
				...(captured.record ?? {}),
				...(captured.persistError
					? { persistError: captured.persistError }
					: {}),
			},
		};
	}

	async function runTriageForEvent(
		event: {
			toolName: string;
			input: unknown;
			content: unknown;
			isError?: boolean;
			details?: unknown;
		},
		ctx: ExtensionContext,
	): Promise<{ annotated: string; details: Record<string, unknown> } | null> {
		const command = (event.input as { command?: unknown } | null)?.command;
		if (typeof command !== "string" || command.length === 0) return null;

		const content = extractTextContent(event.content);
		if (content === null) return null;

		const stage = await resolveGuardStage(ctx);
		const captured: { record: PersistedTriage | null; persistError?: string } = {
			record: null,
		};

		const annotated = await runFailureTriage(
			{
				toolName: event.toolName,
				isError: event.isError ?? false,
				command,
				stage,
				content,
			},
			{
				runtime: getJevRuntime(),
				repoRoot: ctx.cwd,
				cwd: ctx.cwd,
				onRecord: (record) => {
					captured.record = record;
				},
				onPersistError: (error) => {
					captured.persistError =
						error instanceof Error ? error.message : String(error);
				},
			},
		);
		if (annotated === null) return null;

		return { annotated, details: buildTriageDetails(event.details, captured) };
	}

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		try {
			const result = await runTriageForEvent(event, ctx);
			if (!result) return undefined;

			return {
				content: [{ type: "text", text: result.annotated }],
				details: result.details,
			};
		} catch (err) {
			// ponytail: a triage bug never blocks or corrupts the bash result.
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Failure triage failed open: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
			return undefined;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const queued = pendingAutoAdvance;
		if (!queued) return undefined;
		pendingAutoAdvance = null;
		startAutoAdvanceWhenIdle(ctx, queued);
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		pendingAutoAdvance = null;
		clearRememberedCommandContext();
		clearActiveStage();
		return undefined;
	});

	// Tree summary prompt optimizer — keeps branch summaries focused
	pi.on("session_before_tree", async (_event, _ctx) => {
		return {
			customInstructions: COMPACTION_FOCUS_INSTRUCTIONS,
			replaceInstructions: false,
		};
	});
}

export { createArtifactHelperTool } from "./tools/artifact-helper";
export { createWorkflowStateTool } from "./tools/workflow-state";
export { createReviewRouterTool } from "./tools/review-router";
export { createSessionCheckpointTool } from "./tools/session-checkpoint";
export { createTaskSplitterTool } from "./tools/task-splitter";
export { createBrainstormDialogTool } from "./tools/brainstorm-dialog";
export { createPlanDiffTool } from "./tools/plan-diff";
export { createSessionHistoryTool } from "./tools/session-history";
export { createPatternExtractorTool } from "./tools/pattern-extractor";
export { createContextHandoffTool } from "./tools/context-handoff";
export { createStageGateTool } from "./tools/stage-gate";
export { createMultiReviewerTool } from "./tools/multi-reviewer";
export {
	createChecklistAddTool,
	createChecklistShowTool,
	createChecklistDelTool,
} from "./tools/checklist";
export {
	getBrainstormArtifactPath,
	getPlanArtifactPath,
	getSolutionArtifactPath,
	getRunArtifactPath,
} from "./utils/artifact-paths";
export { normalizeSlug } from "./utils/name-utils";
export { filterBashOutput } from "./tools/bash-output-filter";
export { filterReadOutput } from "./tools/read-output-filter";
export { COMPACTION_FOCUS_INSTRUCTIONS } from "./tools/compaction-optimizer";
