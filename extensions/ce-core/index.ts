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
	autoReloadEscalatedStage,
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
import { createStageReportTool } from "./tools/stage-report";
import { createDocsVerificationWiring } from "./utils/docs-verification-wiring";
import {
	resolveSessionKey,
	setCurrentDriftSessionKey,
	getCurrentDriftSessionKey,
} from "./drift/store";
import {
	createDriftGuard,
	type DriftGuard,
} from "./drift/guard";
import { formatDriftCorrection } from "./drift/combine";
import {
	appendHealthDegradedLog,
	captureContextSnapshot,
	clearContextSnapshot,
	getCurrentCompactionSessionKey,
	getCurrentContextHealth,
	getOrCreateSessionState,
	resetAllSessionState,
	resetEpisode,
	setCurrentCompactionMode,
	setCurrentCompactionSessionKey,
} from "./compaction-guard/store";
import {
	createCompactionGuard,
	type CompactionGuard,
	type CompactionGuardInput,
} from "./compaction-guard/guard";
import { RECENT_ENTRIES, deriveTier } from "./compaction-guard/facts";
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
import {
	createStageGuard,
	type StageGuard,
} from "./utils/stage-guard-runtime";
import { createJevRuntime } from "./jev/runtime";
import type { JevRuntime } from "./jev/types";
import { resolveStartupFeatures } from "./utils/startup-features";
import { readPiPedstackConfig } from "./utils/config-types";
import { stageAllowsSotaEscalation } from "./utils/stage-policy";
import { diagnosticJevOptions, isDiagnosticVerificationCall, recordDiagnostic, recordSolutionSearch, recordDiagnosticHandoff, completeDiagnosticWorkflow, shutdownDiagnostics, getDiagnosticRole } from "./diagnostics";

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

const stageReportParams = Type.Object({
	stage: Type.String(),
	markdown: Type.String(),
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
	mode: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("deep")], {
			description:
				"Review depth: single runs exactly one reviewer, deep runs all configured reviewers; omit for legacy behavior",
		}),
	),
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

// Test seam: the drift guard's Jev runtime (separate from the bash guard).
let driftJevFactory: (() => JevRuntime) | null = null;

/** @internal Test-only injection seam for the drift Jev runtime. */
export function __setDriftJevFactory(
	factory: (() => JevRuntime) | null,
): void {
	driftJevFactory = factory;
}

// Test seam: the compaction guard's Jev runtime (separate from drift/bash).
let compactionJevFactory: (() => JevRuntime) | null = null;

/** @internal Test-only injection seam for the compaction-guard Jev runtime. */
export function __setCompactionGuardJevFactory(
	factory: (() => JevRuntime) | null,
): void {
	compactionJevFactory = factory;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function extractMessageText(message: unknown): string {
	const record = asRecord(message);
	if (!record) return "";
	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return "";
	let text = "";
	for (const block of record.content) {
		const entry = asRecord(block);
		if (!entry) continue;
		if (typeof entry.text === "string") text += `${entry.text}\n`;
		else if (typeof entry.name === "string") text += `[tool ${entry.name}]\n`;
	}
	return text.trim();
}

/** Last RECENT_ENTRIES non-empty message excerpts from the cut region. */
function extractRecentEntries(event: unknown): string[] {
	const preparation = asRecord(asRecord(event)?.preparation) ?? {};
	const messages = [
		...toStringList(preparation.turnPrefixMessages),
		...toStringList(preparation.messagesToSummarize),
	];
	const entries = messages.map(extractMessageText).filter((t) => t.length > 0);
	return entries.slice(-RECENT_ENTRIES);
}

function toStringList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The current model window; the hook paths never resolve a tier from it (AD-3). */
function readContextWindow(ctx: ExtensionContext): number | null {
	try {
		const usage = ctx.getContextUsage?.();
		if (usage && typeof usage.contextWindow === "number") {
			return usage.contextWindow;
		}
	} catch {
		// fall through to the model fallback
	}
	const model = ctx.model as { contextWindow?: unknown } | undefined;
	return typeof model?.contextWindow === "number" ? model.contextWindow : null;
}

/**
 * Map the awaited hook event to a normalized guard input. `reason`/`willRetry`
 * are read defensively: on a Pi version without them the reason is `unknown`, so
 * the guard short-circuits to a deterministic `allow` (fail open).
 */
function mapCompactionEvent(
	event: unknown,
	ctx: ExtensionContext,
): CompactionGuardInput {
	const record = asRecord(event) ?? {};
	const preparation = asRecord(record.preparation) ?? {};
	const settings = asRecord(preparation.settings) ?? {};
	return {
		repoRoot: ctx.cwd,
		reason: typeof record.reason === "string" ? record.reason : "unknown",
		willRetry: record.willRetry === true,
		tokensBefore: preparation.tokensBefore,
		contextWindow: readContextWindow(ctx),
		reserveTokens: settings.reserveTokens,
		isSplitTurn: preparation.isSplitTurn,
		recentEntries: extractRecentEntries(event),
		priorSummary: preparation.previousSummary,
	};
}

export default function ceCoreExtension(pi: ExtensionAPI) {
	const artifactHelper = createArtifactHelperTool();
	const stageReport = createStageReportTool();
	const workflowState = createWorkflowStateTool();
	const reviewRouter = createReviewRouterTool();
	const sessionCheckpoint = createSessionCheckpointTool();
	const taskSplitter = createTaskSplitterTool();
	const brainstormDialog = createBrainstormDialogTool();
	const planDiff = createPlanDiffTool();
	const sessionHistory = createSessionHistoryTool();
	const patternExtractor = createPatternExtractorTool();
	// Runtime feature policy has exactly one source of truth: config.json.
	// Resolve once at extension init, matching the previous startup semantics
	// without allowing environment variables to silently diverge from JSON.
	const features = resolveStartupFeatures();
	const gateMode = features.stageGate.mode;
	const overengineeringMode = features.overengineering.mode;
	const driftMode = features.driftGuard.mode;
	const driftFailClosed = features.driftGuard.failClosed;
	const compactionMode = features.compactionGuard.mode;
	const compactionLive = features.compactionGuard.live;
	const guardMode = features.stageGuard.mode;
	const guardFailClosed = features.stageGuard.failClosed;
	const guardDisabled = features.stageGuard.disabled;
	setCurrentCompactionMode(compactionMode);
	const docsWiring = createDocsVerificationWiring({
		mode: features.docsVerification.mode,
		failClosed: features.docsVerification.failClosed,
	});
	const contextHandoff = createContextHandoffTool({
		gateMode,
		readiness: {
			mode: features.handoffReadiness.mode,
			failClosed: features.handoffReadiness.failClosed,
		},
		docsVerification: docsWiring,
		drift: {
			mode: driftMode,
			failClosed: driftFailClosed,
			sessionKey: getCurrentDriftSessionKey,
		},
		health: {
			read: () => getCurrentContextHealth(),
			logDegraded: appendHealthDegradedLog,
		},
	});
	const stageGate = createStageGateTool({ mode: gateMode, overengineeringMode });
	const multiReviewer = createMultiReviewerTool();
	const checklistAdd = createChecklistAddTool();
	const checklistShow = createChecklistShowTool();
	const checklistDel = createChecklistDelTool();
	let pendingAutoAdvance: {
		stageKey: PipelineStageKey;
		stagePair: string | null;
		isGated: boolean;
	} | null = null;
	let pendingGateReload: { repoRoot: string; stageKey: PipelineStageKey } | null = null;
	const attemptedAutoReload = new Set<string>();

	let persistedStageResolved = false;
	let persistedStage: string | null = null;
	let guardNotified = false;
	const activeDiagnosticTools = new Map<string, { startedAt: number; feature: "tool" | "review" | "workflow" | "stage_gate" | "solution_search" | "verification"; event: string }>();
	const activeDiagnosticProviders: number[] = [];
	const diagnosticNow = () => performance.now();
	const diagnosticFeatureForTool = (name: string): "tool" | "review" | "workflow" | "stage_gate" | "solution_search" => {
		if (name === "multi_reviewer") return "review";
		if (name === "stage_gate") return "stage_gate";
		if (name === "context_handoff") return "workflow";
		if (name === "solution_search") return "solution_search";
		return "tool";
	};

	// ponytail: Jev runtime created once, lazily; no process spawns until decide().
	let jevRuntime: ReturnType<typeof createJevRuntime> | null = null;
	function getJevRuntime() {
		jevRuntime ??= createJevRuntime({ ...diagnosticJevOptions("failure_triage", getActiveStage) });
		return jevRuntime;
	}

	let stageGuard: StageGuard | null = null;
	let driftGuard: DriftGuard | null = null;
	let compactionGuard: CompactionGuard | null = null;

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
		name: stageReport.name,
		label: "Stage Report",
		description: "Safely publish the active stage canonical Markdown report.",
		parameters: stageReportParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await stageReport.execute({ repoRoot: ctx.cwd, stage: params.stage, activeStage: await resolveGuardStage(ctx), markdown: params.markdown });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
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

	// An escalation is observed after the stage_gate tool returns, then acted
	// on only at agent_end so navigation never interrupts an executing turn.
	async function queueGateEscalation(event: {
		toolName: string;
		isError?: boolean;
		details?: unknown;
	}, ctx: ExtensionContext): Promise<void> {
		if (event.toolName !== "stage_gate" || event.isError) return;
		const result = event.details as {
			stage?: unknown;
			action?: unknown;
			enforcing?: unknown;
		} | undefined;
		if (!result || typeof result.stage !== "string" || !isValidStageKey(result.stage)) return;
		if (!stageAllowsSotaEscalation(result.stage)) {
			if (pendingGateReload?.stageKey === result.stage) pendingGateReload = null;
			return;
		}
		if (result.action !== "escalate" || result.enforcing !== true) {
			if (pendingGateReload?.stageKey === result.stage) pendingGateReload = null;
			return;
		}
		let config;
		try {
			config = await readPiPedstackConfig(ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`Cannot queue SOTA escalation: invalid model configuration (${String(err)})`, "warning");
			return;
		}
		const stageKey = result.stage as PipelineStageKey;
		const stageConfigKey = stageKey === "04-5-debug" ? "debug" : stageKey.slice(3);
		const override = (config as Record<string, { model?: string }> | null)?.[stageConfigKey]?.model;
		const sota = config?.models?.sota?.model;
		if (config?.routing?.shadow !== false || !sota || override) return;
		const active = getActiveStage() ?? await readPersistedActiveStage(ctx.cwd);
		if (active !== stageKey) return;
		if (ctx.model && `${ctx.model.provider}/${ctx.model.id}` === sota) return;
		const key = `${ctx.cwd}:${stageKey}`;
		if (attemptedAutoReload.has(key)) return;
		pendingGateReload = { repoRoot: ctx.cwd, stageKey };
		if (ctx.hasUI) ctx.ui.notify(`Stage gate escalation queued: ${stageKey} will automatically restart under SOTA when the turn finishes.`, "info");
		return;
	}

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

	const startCommand = cmdPedStart(pi);
	pi.registerCommand("ped-start", {
		...startCommand,
		handler: async (args, ctx) => {
			// A new workflow has a fresh stage-escalation budget.
			pendingGateReload = null;
			attemptedAutoReload.clear();
			await startCommand.handler(args, ctx);
		},
	});
	pi.registerCommand("ped-next", cmdPedNext(pi));
	const fixIssuesCommand = cmdPedFixIssues(pi);
	pi.registerCommand("ped-fix-issues", {
		...fixIssuesCommand,
		handler: async (args, ctx) => {
			pendingGateReload = null;
			attemptedAutoReload.clear();
			await fixIssuesCommand.handler(args, ctx);
		},
	});
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
				stageGuardJevFactory ? stageGuardJevFactory() : createJevRuntime({ ...diagnosticJevOptions("shell_guard", getActiveStage) }),
		});
		return stageGuard;
	}

	/** Lazily build the drift guard, memoizing the Jev runtime on first use. */
	function getDriftGuard(): DriftGuard {
		driftGuard ??= createDriftGuard({
			mode: driftMode,
			failClosed: driftFailClosed,
			sessionKey: () => getCurrentDriftSessionKey(),
			createJev: () =>
				driftJevFactory ? driftJevFactory() : createJevRuntime({ ...diagnosticJevOptions("drift", getActiveStage) }),
		});
		return driftGuard;
	}

	/** Lazily build the compaction guard, memoizing the Jev runtime on first use. */
	function getCompactionGuard(): CompactionGuard {
		compactionGuard ??= createCompactionGuard({
			mode: compactionMode,
			live: compactionLive,
			sessionKey: () => getCurrentCompactionSessionKey(),
			createJev: () =>
				compactionJevFactory ? compactionJevFactory() : createJevRuntime({ ...diagnosticJevOptions("compaction", getActiveStage) }),
		});
		return compactionGuard;
	}

	/** Capture the per-turn usage snapshot and fire the one-shot request nudge. */
	function captureTurnSnapshot(ctx: ExtensionContext, sessionKey: string): void {
		try {
			const usage = ctx.getContextUsage?.();
			if (!usage || typeof usage.contextWindow !== "number") return;
			captureContextSnapshot({
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
			});
			const tier = deriveTier(
				usage.tokens === null ? null : usage.tokens / usage.contextWindow,
			);
			if (tier !== "request") return;
			const state = getOrCreateSessionState(sessionKey);
			if (state.requestNotified) return;
			state.requestNotified = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Pedstack compaction guard: context pressure is critical; " +
						"save a handoff or compact soon.",
					"warning",
				);
			}
		} catch {
			// ponytail: snapshot capture is best-effort; keep the last snapshot.
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (guardDisabled) return undefined;

		try {
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

	// Turn-level drift detection (AD-1/AD-5) + compaction snapshot capture.
	// Additive, fail-open, never blocks.
	pi.on("turn_end", async (event, ctx) => {
		try {
			if (driftMode === "off" && compactionMode === "off") return undefined;
			const sessionKey = resolveSessionKey(ctx.sessionManager);

			if (compactionMode !== "off") {
				setCurrentCompactionSessionKey(sessionKey);
				captureTurnSnapshot(ctx, sessionKey);
			}

			if (driftMode !== "off") {
				setCurrentDriftSessionKey(sessionKey);
				const stage = await resolveGuardStage(ctx);
				await getDriftGuard().evaluate({
					repoRoot: ctx.cwd,
					stage,
					message: event.message,
					toolResults: event.toolResults,
					turnIndex: event.turnIndex,
				});
			}
		} catch {
			// ponytail: additive handler — a bug here must never break a turn.
		}
		return undefined;
	});

	// Capture skills and inject pending skill path into system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.systemPromptOptions?.skills?.length) {
			initSkillRegistry(event.systemPromptOptions.skills);
		}

		const skillPath = getAndClearPendingSkillPath();
		const fixIssues = getAndClearPendingFixIssues();

		const append = buildSystemPromptAppend(skillPath, fixIssues);
		// One-shot drift correction: after pipeline discipline, before solutions.
		const driftBlock =
			driftMode === "off"
				? undefined
				: formatDriftCorrection(getDriftGuard().getAndClearCorrection());
		const solutionsBlock = ctx?.cwd
			? await buildSolutionsAppend({ repoRoot: ctx.cwd, skillPath })
			: undefined;
		const docsBlock = ctx?.cwd
			? await docsWiring.buildAppend({ repoRoot: ctx.cwd, skillPath })
			: undefined;
		const injectedSolutions = [solutionsBlock, docsBlock]
			.filter((block): block is string => Boolean(block))
			.join("");
		return composeSolutionSystemPrompt(
			event.systemPrompt,
			append + (driftBlock ?? ""),
			injectedSolutions || undefined,
		);
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
				mode: params.mode,
			});

			return {
				content: [{ type: "text", text: result.compiledSummary }],
				details: result,
			};
		},
	});

	// Semantic solution ranking: model-facing tool + auto-injection (one handler above).
	registerSolutionSearch(pi);

	// Docs verification: model-facing tool (injection ran in the one handler above).
	docsWiring.register(pi);

	// Injection screen phase 1 — screens raw untrusted results before the size
	// filters compress them (registered first; phase 2 below runs last).
	const injectionScreen = registerInjectionScreen(pi, {
		mode: features.injectionScreen.mode,
	});

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
		if (event.toolName === "stage_gate") {
			await queueGateEscalation(event, ctx);
			return undefined;
		}
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
		const escalation = pendingGateReload;
		pendingGateReload = null;
		if (escalation) {
			pendingAutoAdvance = null;
			const key = `${escalation.repoRoot}:${escalation.stageKey}`;
			if (!attemptedAutoReload.has(key)) {
				attemptedAutoReload.add(key);
				let remainingIdleChecks = 40;
				const retry = () => {
					let idle = false;
					try {
						idle = ctx.isIdle();
					} catch {
						return;
					}
					if (!idle) {
						if (--remainingIdleChecks === 0) {
							if (ctx.hasUI) ctx.ui.notify("Automatic SOTA reload timed out waiting for idle. Run /ped-reload manually.", "warning");
							return;
						}
						setTimeout(retry, 50);
						return;
					}
					void autoReloadEscalatedStage(pi, escalation.repoRoot, escalation.stageKey)
						.then((started) => {
							if (!started && ctx.hasUI) ctx.ui.notify("Automatic SOTA reload could not start. Run /ped-reload manually.", "warning");
						})
						.catch((err) => {
							if (ctx.hasUI) ctx.ui.notify(`Automatic SOTA reload failed: ${String(err)}`, "error");
						});
				};
				setTimeout(retry, 0);
			}
			return undefined;
		}
		const queued = pendingAutoAdvance;
		if (!queued) return undefined;
		pendingAutoAdvance = null;
		startAutoAdvanceWhenIdle(ctx, queued);
		return undefined;
	});

	pi.on("session_start", async () => {
		pendingGateReload = null;
		attemptedAutoReload.clear();
		// Fresh session: reset per-session state (record files untouched).
		driftGuard?.reset();
		setCurrentDriftSessionKey("");
		resetAllSessionState();
		clearContextSnapshot();
		await shutdownDiagnostics(true);
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		pendingGateReload = null;
		attemptedAutoReload.clear();
		pendingAutoAdvance = null;
		clearRememberedCommandContext();
		clearActiveStage();
		// In-memory only: record files stay on disk (AD-6).
		driftGuard?.reset();
		setCurrentDriftSessionKey("");
		resetAllSessionState();
		clearContextSnapshot();
		await shutdownDiagnostics();
		return undefined;
	});

	pi.on("message_end", async (event) => {
		const message = event.message as unknown as Record<string, unknown>;
		if (!message || typeof message !== "object" || message.role !== "assistant") return undefined;
		const usage = typeof message.usage === "object" && message.usage !== null
			? message.usage as Record<string, unknown> : null;
		const inputTokens = usage && typeof usage.input === "number" ? usage.input : undefined;
		const outputTokens = usage && typeof usage.output === "number" ? usage.output : undefined;
		const cost = usage && typeof usage.cost === "object" && usage.cost !== null
			? usage.cost as Record<string, unknown> : null;
		const costUsd = cost && typeof cost.total === "number" ? cost.total : undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted") activeDiagnosticProviders.length = 0;
		recordDiagnostic({
			feature: "model", event: "model_response", stage: getActiveStage() ?? "unknown",
			role: getDiagnosticRole(),
			usageKnown: inputTokens !== undefined && outputTokens !== undefined,
			...(inputTokens !== undefined ? { inputTokens } : {}),
			...(outputTokens !== undefined ? { outputTokens } : {}),
			...(costUsd !== undefined ? { costUsd } : {}),
		});
		return undefined;
	});

	pi.on("before_provider_request", async () => {
		activeDiagnosticProviders.push(diagnosticNow());
		recordDiagnostic({
			feature: "model", event: "provider_request", stage: getActiveStage() ?? "unknown",
			role: getDiagnosticRole(), modelCalls: 1, providerRequests: 1,
		});
		return undefined;
	});

	pi.on("after_provider_response", async (event) => {
		const startedAt = activeDiagnosticProviders.shift();
		if (startedAt !== undefined) {
			recordDiagnostic({
				feature: "model", event: "provider_response", stage: getActiveStage() ?? "unknown",
				role: getDiagnosticRole(),
				providerResponseMs: diagnosticNow() - startedAt,
				outcome: event.status >= 400 ? "failure" : "success",
			});
		}
		return undefined;
	});

	pi.on("tool_execution_start", async (event) => {
		const verification = isDiagnosticVerificationCall(event.toolName, event.args);
		activeDiagnosticTools.set(event.toolCallId, {
			startedAt: diagnosticNow(),
			feature: verification ? "verification" : diagnosticFeatureForTool(event.toolName),
			event: verification ? "verification_execution" : "tool_execution",
		});
		if (event.toolName === "solution_search") {
			const args = event.args as { query?: unknown } | null;
			recordSolutionSearch(getActiveStage(), args?.query);
		}
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		const started = activeDiagnosticTools.get(event.toolCallId);
		activeDiagnosticTools.delete(event.toolCallId);
		if (started) {
			recordDiagnostic({
				feature: started.feature, event: started.event, stage: getActiveStage() ?? "unknown",
				outcome: event.isError ? "failure" : "success",
				durationMs: diagnosticNow() - started.startedAt,
			});
		}
		if (event.toolName === "stage_gate" && !event.isError) {
			const result = event.result as { details?: { stage?: unknown; verdict?: unknown; action?: unknown; skipped?: unknown; error?: unknown } } | undefined;
			const details = result?.details;
			if (
				getActiveStage() === "06-docsync" &&
				details?.stage === "06-docsync" &&
				details.verdict === "accept" &&
				details.action === "none" &&
				details.skipped !== true &&
				!details.error
			) {
				await completeDiagnosticWorkflow("06-docsync");
			}
		}
		if (event.toolName === "context_handoff" && !event.isError) {
			const result = event.result as { details?: { operation?: unknown; currentStage?: unknown; nextStage?: unknown; blocker?: unknown; reviewOutcome?: unknown; reviewFindings?: unknown } } | undefined;
			const details = result?.details;
			if (details?.operation === "save" && typeof details.currentStage === "string" && !details.blocker) {
				if (
					details.currentStage === "04-review" &&
					(details.reviewOutcome === "clean" || details.reviewOutcome === "findings") &&
					typeof details.reviewFindings === "number" &&
					Number.isSafeInteger(details.reviewFindings) &&
					details.reviewFindings >= 0
				) {
					recordDiagnostic({
						feature: "review", event: "review_outcome", stage: "04-review",
						outcome: "success", reviewFindings: details.reviewFindings,
					});
				}
				if (typeof details.nextStage === "string" && details.nextStage && details.currentStage !== details.nextStage) {
					recordDiagnosticHandoff(details.currentStage, details.nextStage);
				}
			}
		}
		return undefined;
	});

	// `session_compact` ends the threshold episode: keep the entry, reset counters.
	pi.on("session_compact", async (_event, ctx) => {
		try {
			const sessionKey =
				ctx?.sessionManager && typeof ctx.sessionManager === "object"
					? resolveSessionKey(ctx.sessionManager)
					: getCurrentCompactionSessionKey();
			resetEpisode(sessionKey);
		} catch {
			// ponytail: lifecycle reset is best-effort and never blocks.
		}
		return undefined;
	});

	// Compaction hook: the only place a `{ cancel: true }` can be produced (AD-8).
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			if (compactionMode === "off") return undefined;
			const sessionKey = resolveSessionKey(ctx.sessionManager);
			setCurrentCompactionSessionKey(sessionKey);
			const result = await getCompactionGuard().evaluate(
				mapCompactionEvent(event, ctx),
			);
			if (compactionMode === "enforce" && result.action === "defer") {
				return { cancel: true };
			}
		} catch {
			// ponytail: shape drift or a guard bug fails open to stock Pi.
		}
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
