import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createArtifactHelperTool, type ArtifactType } from "./tools/artifact-helper"
import { createWorkflowStateTool } from "./tools/workflow-state"
import { createReviewRouterTool } from "./tools/review-router"
import { createSessionCheckpointTool } from "./tools/session-checkpoint"
import { createTaskSplitterTool } from "./tools/task-splitter"
import { createBrainstormDialogTool } from "./tools/brainstorm-dialog"
import { createPlanDiffTool } from "./tools/plan-diff"
import { createSessionHistoryTool } from "./tools/session-history"
import { createPatternExtractorTool } from "./tools/pattern-extractor"
import { createContextHandoffTool } from "./tools/context-handoff"
import { filterBashOutput } from "./tools/bash-output-filter"
import { filterReadOutput } from "./tools/read-output-filter"
import { COMPACTION_FOCUS_INSTRUCTIONS } from "./tools/compaction-optimizer"
import { readPiPedstackConfig, getConfigKeyForSkill } from "./utils/config-types"
import { loadAppendContext } from "./utils/append-loader"
import { createMultiReviewerTool } from "./tools/multi-reviewer"
import { registerImageDescriptorHook, createImageDescriptorTool } from "./tools/image-descriptor"

const artifactHelperParams = Type.Object({
  repoRoot: Type.String({ description: "Repository root where workflow artifacts should be created" }),
  artifactType: Type.Union([
    Type.Literal("brainstorm"),
    Type.Literal("plan"),
    Type.Literal("solution"),
    Type.Literal("run"),
  ], { description: "Artifact type to resolve" }),
  date: Type.Optional(Type.String({ description: "Date prefix for dated artifacts" })),
  topic: Type.Optional(Type.String({ description: "Topic or slug source for the artifact" })),
  category: Type.Optional(Type.String({ description: "Solution category for docs/solutions" })),
  skillName: Type.Optional(Type.String({ description: "Skill name for run artifacts" })),
  runId: Type.Optional(Type.String({ description: "Run identifier for runtime artifacts" })),
  ensureDir: Type.Optional(Type.Boolean({ description: "Create the parent directory when true" })),
})

const workflowStateParams = Type.Object({
  repoRoot: Type.String({ description: "Repository root to scan for workflow artifacts" }),
})

const reviewRouterParams = Type.Object({
  filesChanged: Type.Array(Type.String(), { description: "List of file paths changed in the diff" }),
  insertions: Type.Number({ description: "Number of lines added" }),
  deletions: Type.Number({ description: "Number of lines removed" }),
})

const sessionCheckpointParams = Type.Object({
  operation: Type.Union([
    Type.Literal("save"),
    Type.Literal("load"),
    Type.Literal("list"),
    Type.Literal("fail"),
    Type.Literal("retry"),
  ], { description: "Checkpoint operation" }),
  repoRoot: Type.String({ description: "Repository root" }),
  planPath: Type.Optional(Type.String({ description: "Plan artifact path" })),
  completedUnits: Type.Optional(Type.Array(Type.String(), { description: "List of completed implementation unit names" })),
  failedUnit: Type.Optional(Type.String({ description: "Name of the unit that failed" })),
  error: Type.Optional(Type.String({ description: "Error message from the failure" })),
})

const splitterUnitSchema = Type.Object({
  name: Type.String({ description: "Implementation unit name" }),
  files: Type.Array(Type.String(), { description: "Files this unit touches" }),
})

const taskSplitterParams = Type.Object({
  units: Type.Array(splitterUnitSchema, { description: "Implementation units to analyze for dependencies" }),
})

const brainstormDialogParams = Type.Object({
  operation: Type.Union([
    Type.Literal("start"),
    Type.Literal("refine"),
    Type.Literal("summarize"),
  ], { description: "Dialog operation" }),
  repoRoot: Type.String({ description: "Repository root" }),
  artifactPath: Type.String({ description: "Brainstorm artifact path" }),
  analysis: Type.Optional(Type.String({ description: "Agent's current analysis" })),
  questions: Type.Optional(Type.Array(Type.String(), { description: "Open questions for the user" })),
  userResponses: Type.Optional(Type.Array(Type.String(), { description: "User's answers from previous round" })),
})

const planUnitSchema = Type.Object({
  name: Type.String({ description: "Unit name" }),
  description: Type.String({ description: "Unit description" }),
  files: Type.Array(Type.String(), { description: "Files this unit touches" }),
})

const planChangeSchema = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("modify")], { description: "Change action" }),
  name: Type.String({ description: "Unit name" }),
  description: Type.Optional(Type.String({ description: "Updated description" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Updated file list" })),
})

const planDiffParams = Type.Object({
  operation: Type.Union([Type.Literal("compare"), Type.Literal("patch")], { description: "Diff operation" }),
  existingUnits: Type.Array(planUnitSchema, { description: "Current plan units" }),
  newRequirements: Type.Optional(Type.Array(planUnitSchema, { description: "Updated requirements for compare" })),
  changes: Type.Optional(Type.Array(planChangeSchema, { description: "Changes to apply for patch" })),
})

const sessionHistoryParams = Type.Object({
  operation: Type.Union([
    Type.Literal("record"),
    Type.Literal("query"),
    Type.Literal("latest"),
  ], { description: "History operation" }),
  repoRoot: Type.String({ description: "Repository root" }),
  skill: Type.Optional(Type.String({ description: "Skill name to filter or record" })),
  artifactPath: Type.Optional(Type.String({ description: "Artifact path" })),
  summary: Type.Optional(Type.String({ description: "Execution summary" })),
})

const artifactInputSchema = Type.Object({
  path: Type.String({ description: "Artifact path" }),
  content: Type.String({ description: "Artifact content" }),
})

const patternSchema = Type.Object({
  keyword: Type.String({ description: "Pattern keyword" }),
  occurrences: Type.Number({ description: "Number of occurrences" }),
  sources: Type.Array(Type.String(), { description: "Artifact sources" }),
})

const contextHandoffParams = Type.Object({
  operation: Type.Union([
    Type.Literal("save"),
    Type.Literal("load"),
    Type.Literal("latest"),
    Type.Literal("status"),
    Type.Literal("validate"),
  ], { description: "Handoff operation" }),
  repoRoot: Type.String({ description: "Repository root" }),
  currentStage: Type.Optional(Type.String({ description: "Current pipeline stage (e.g. 02-plan)" })),
  nextStage: Type.Optional(Type.String({ description: "Next pipeline stage" })),
  contextHealth: Type.Optional(Type.Union([
    Type.Literal("good"),
    Type.Literal("watch"),
    Type.Literal("heavy"),
    Type.Literal("critical"),
  ], { description: "Context health assessment" })),
  activeFiles: Type.Optional(Type.Array(Type.String(), { description: "1-5 must-know active file paths" })),
  blocker: Type.Optional(Type.String({ description: "Current blocker description" })),
  verification: Type.Optional(Type.String({ description: "Latest verification command + result" })),
  artifacts: Type.Optional(Type.Record(Type.String(), Type.Optional(Type.String()), { description: "Artifact paths (requirements, plan, checkpoint, proof)" })),
  handoffMarkdown: Type.Optional(Type.String({ description: "Custom handoff markdown content" })),
  handoffPath: Type.Optional(Type.String({ description: "Specific handoff file path to load" })),
  currentTruth: Type.Optional(Type.Array(Type.String(), { description: "Known true statements validated during session" })),
  invalidatedAssumptions: Type.Optional(Type.Array(Type.String(), { description: "Assumptions proven wrong during session" })),
  openDecisions: Type.Optional(Type.Array(Type.String(), { description: "Pending decisions that affect next steps" })),
  recentlyAccessedFiles: Type.Optional(Type.Array(Type.String(), { description: "Files recently read or edited (defaults to activeFiles)" })),
  compressionRisk: Type.Optional(Type.Array(Type.String(), { description: "Context compression risks to watch for" })),
  activeRules: Type.Optional(Type.Array(Type.String(), { description: "1-5 must-know rules for continuation (TDD gates, constraints, do-not-repeat)" })),
})

const reviewerConfigSchema = Type.Object({
  model: Type.String({ description: "Model ID/name" }),
  thinkingLevel: Type.String({ description: "Thinking level" }),
})

const multiReviewerParams = Type.Object({
  stepName: Type.String({ description: "Pipeline step name" }),
  primaryOutput: Type.String({ description: "Code changes or output to review" }),
  repoRoot: Type.String({ description: "Repository root path" }),
})

const imageDescriptorParams = Type.Object({
  imagePath: Type.String({ description: "Path to the image (relative or absolute)" }),
  prompt: Type.Optional(Type.String({ description: "Optional instruction prompt to guide description" })),
})

const patternExtractorParams = Type.Object({
  operation: Type.Union([
    Type.Literal("extract"),
    Type.Literal("categorize"),
  ], { description: "Pattern operation" }),
  artifacts: Type.Optional(Type.Array(artifactInputSchema, { description: "Artifacts to analyze" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Keywords to search for" })),
  patterns: Type.Optional(Type.Array(patternSchema, { description: "Patterns to categorize" })),
  categories: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), { description: "Category name to keyword mapping" })),
})

const PIPELINE_STAGE_KEYS = new Set([
  "01-brainstorm",
  "02-plan",
  "03-work",
  "04-review",
  "04-5-debug",
  "05-learn",
  "06-docsync",
])

function parseStageSkillName(text: string): string | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^\/skill:([^\s]+)/)
  if (!match) {
    return null
  }

  const skillName = match[1]
  return PIPELINE_STAGE_KEYS.has(skillName) ? skillName : null
}

function parseModelRef(
  modelRef: string,
  currentProvider?: string,
): { provider: string, id: string } | null {
  const trimmed = modelRef.trim()
  if (!trimmed) {
    return null
  }

  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex),
      id: trimmed.slice(slashIndex + 1),
    }
  }

  if (!currentProvider) {
    return null
  }

  return {
    provider: currentProvider,
    id: trimmed,
  }
}

export default function ceCoreExtension(pi: ExtensionAPI) {
  registerImageDescriptorHook(pi)

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" as const }
    }

    const stageKey = parseStageSkillName(event.text)
    if (!stageKey) {
      return { action: "continue" as const }
    }

    // Skip model/thinking switching during streaming steers — these are
    // mid-stream interrupts, not new pipeline invocations.
    const isSteer = (event as any).streamingBehavior === "steer" || (ctx.isIdle && !ctx.isIdle())
    if (isSteer) {
      return { action: "continue" as const }
    }

    const config = await readPiPedstackConfig(ctx.cwd)
    const configKey = getConfigKeyForSkill(stageKey)
    const stepConfig = configKey ? config?.[configKey] : null
    // Notification guard: only notify in interactive (TUI) or RPC modes.
    const shouldNotify = (ctx as any).mode === "tui" || (ctx as any).mode === "rpc" || ctx.hasUI

    // Model switching
    if (stepConfig?.model) {
      const parsed = parseModelRef(stepConfig.model, ctx.model?.provider)
      if (parsed) {
        // Skip if already using the same model
        if (ctx.model?.provider !== parsed.provider || ctx.model?.id !== parsed.id) {
          const model = ctx.modelRegistry.find(parsed.provider, parsed.id)
          if (model) {
            const switched = await pi.setModel(model)
            if (switched) {
              if (shouldNotify) {
                ctx.ui.notify(`Switched model for ${stageKey}: ${model.provider}/${model.id}`, "info")
              }
            } else {
              if (shouldNotify) {
                ctx.ui.notify(`No API key for ${stageKey}: ${model.provider}/${model.id}`, "warning")
              }
            }
          } else if (shouldNotify) {
            ctx.ui.notify(`Model not found for ${stageKey}: ${stepConfig.model}`, "warning")
          }
        }
      } else if (shouldNotify) {
        ctx.ui.notify(`Invalid model for ${stageKey}: ${stepConfig.model}`, "warning")
      }
    }

    // Thinking level switching
    if (stepConfig?.thinkingLevel) {
      const levelMap: Record<string, ReturnType<ExtensionAPI["getThinkingLevel"]>> = {
        off: "off",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        "0": "low",
        "1": "medium",
        "2": "high",
      }
      const normalized = levelMap[stepConfig.thinkingLevel.toLowerCase()] ?? "medium"
      const currentLevel = pi.getThinkingLevel()
      if (currentLevel !== normalized) {
        pi.setThinkingLevel(normalized)
        if (shouldNotify) {
          ctx.ui.notify(`Switched thinking level for ${stageKey}: ${normalized}`, "info")
        }
      }
    }

    // APPEND.md context loading
    const appendContent = await loadAppendContext(ctx.cwd, stageKey)
    if (appendContent && shouldNotify) {
      ctx.ui.notify(`Loaded APPEND.md context for ${stageKey}`, "info")
    }

    return { action: "continue" as const }
  })

  const artifactHelper = createArtifactHelperTool()
  const workflowState = createWorkflowStateTool()
  const reviewRouter = createReviewRouterTool()
  const sessionCheckpoint = createSessionCheckpointTool()
  const taskSplitter = createTaskSplitterTool()
  const brainstormDialog = createBrainstormDialogTool()
  const planDiff = createPlanDiffTool()
  const sessionHistory = createSessionHistoryTool()
  const patternExtractor = createPatternExtractorTool()
  const contextHandoff = createContextHandoffTool()
  const multiReviewer = createMultiReviewerTool()
  const imageDescriptor = createImageDescriptorTool()

  pi.registerTool({
    name: artifactHelper.name,
    label: "Artifact Helper",
    description: "Resolve and optionally create standard Compound Engineering artifact paths.",
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
      })

      return {
        content: [{ type: "text", text: result.path }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: workflowState.name,
    label: "Workflow State",
    description: "Scan repo-local Compound Engineering artifacts and return structured workflow state.",
    parameters: workflowStateParams,
    async execute(_toolCallId, params) {
      const result = await workflowState.execute({
        repoRoot: params.repoRoot,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: reviewRouter.name,
    label: "Review Router",
    description: "Analyze diff metadata and recommend reviewer personas for structured code review.",
    parameters: reviewRouterParams,
    async execute(_toolCallId, params) {
      const result = await reviewRouter.execute({
        filesChanged: params.filesChanged,
        insertions: params.insertions,
        deletions: params.deletions,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: sessionCheckpoint.name,
    label: "Session Checkpoint",
    description: "Save and load plan execution checkpoints for resume-from-checkpoint behavior.",
    parameters: sessionCheckpointParams,
    async execute(_toolCallId, params) {
      const result = await sessionCheckpoint.execute({
        operation: params.operation,
        repoRoot: params.repoRoot,
        planPath: params.planPath,
        completedUnits: params.completedUnits,
        failedUnit: params.failedUnit,
        error: params.error,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: taskSplitter.name,
    label: "Task Splitter",
    description: "Analyze implementation units for file-level dependencies and output parallel-safe execution groups.",
    parameters: taskSplitterParams,
    async execute(_toolCallId, params) {
      const result = taskSplitter.execute({
        units: params.units,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: brainstormDialog.name,
    label: "Brainstorm Dialog",
    description: "Manage multi-round brainstorm conversations with iterative refinement.",
    parameters: brainstormDialogParams,
    async execute(_toolCallId, params) {
      const result = await brainstormDialog.execute({
        operation: params.operation,
        repoRoot: params.repoRoot,
        artifactPath: params.artifactPath,
        analysis: params.analysis,
        questions: params.questions,
        userResponses: params.userResponses,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: planDiff.name,
    label: "Plan Diff",
    description: "Compare plan units with new requirements or apply incremental changes to an existing plan.",
    parameters: planDiffParams,
    async execute(_toolCallId, params) {
      const result = planDiff.execute({
        operation: params.operation,
        existingUnits: params.existingUnits,
        newRequirements: params.newRequirements,
        changes: params.changes,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

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
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: patternExtractor.name,
    label: "Pattern Extractor",
    description: "Extract and categorize recurring patterns from artifacts.",
    parameters: patternExtractorParams,
    async execute(_toolCallId, params) {
      const input: Record<string, unknown> = { operation: params.operation }
      if (params.artifacts) input.artifacts = params.artifacts
      if (params.keywords) input.keywords = params.keywords
      if (params.patterns) input.patterns = params.patterns
      if (params.categories) input.categories = params.categories

      const result = patternExtractor.execute(input as any)

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: contextHandoff.name,
    label: "Context Handoff",
    description: "Manage cross-stage context handoffs with evidence-first templates. Supports save (write handoff + state), load (read handoff + state), latest (read latest dated handoff), status (read current state), and validate (check continuation readiness with deterministic probes).",
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
        artifacts: params.artifacts as Record<string, string | undefined> | undefined,
        handoffMarkdown: params.handoffMarkdown,
        handoffPath: params.handoffPath,
        currentTruth: params.currentTruth,
        invalidatedAssumptions: params.invalidatedAssumptions,
        openDecisions: params.openDecisions,
        recentlyAccessedFiles: params.recentlyAccessedFiles,
        compressionRisk: params.compressionRisk,
        activeRules: params.activeRules,
      })

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: multiReviewer.name,
    label: "Multi Reviewer",
    description: "Orchestrate multiple reviewer subagents in parallel to review code output.",
    parameters: multiReviewerParams,
    async execute(_toolCallId, params) {
      const result = await multiReviewer.execute({
        stepName: params.stepName,
        primaryOutput: params.primaryOutput,
        repoRoot: params.repoRoot,
      })

      return {
        content: [{ type: "text", text: result.compiledSummary }],
        details: result,
      }
    },
  })

  pi.registerTool({
    name: imageDescriptor.name,
    label: "Image Descriptor",
    description: "Describe an image's contents using the configured vision model.",
    parameters: imageDescriptorParams,
    async execute(_toolCallId, params, ctx) {
      const result = await imageDescriptor.execute({
        imagePath: params.imagePath,
        prompt: params.prompt,
      }, ctx)

      return {
        content: [{ type: "text", text: result }],
        details: { description: result },
      }
    },
  })

  // Bash output smart filter — reduces context waste from verbose command output
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return undefined

    // Extract command from input
    const command = (event.input as any)?.command ?? ""
    if (!command) return undefined

    // Extract text content from tool result
    const textBlocks = (event.content as Array<any>)?.filter((b: any) => b.type === "text") ?? []
    if (textBlocks.length === 0) return undefined

    const output = textBlocks.map((b: any) => b.text).join("")
    const fullOutputPath = (event.details as any)?.fullOutputPath

    const result = filterBashOutput({
      command,
      output,
      isError: event.isError ?? false,
      fullOutputPath,
    })

    if (!result.filtered) return undefined

    // Replace content with filtered version
    return {
      content: [{ type: "text", text: result.output }],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        bashFilter: {
          strategy: result.strategy,
          originalBytes: result.originalBytes,
          filteredBytes: result.filteredBytes,
        },
      },
    }
  })

  // Read output smart filter — reduces context waste from large file reads
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "read") return undefined

    // Extract path from input
    const path = (event.input as any)?.path ?? ""
    if (!path) return undefined

    // Extract text content from tool result
    const textBlocks = (event.content as Array<any>)?.filter((b: any) => b.type === "text") ?? []
    if (textBlocks.length === 0) return undefined

    const output = textBlocks.map((b: any) => b.text).join("")
    const isImage = (event.content as Array<any>)?.some((b: any) => b.type === "image") ?? false

    const result = filterReadOutput({
      path,
      output,
      isError: event.isError ?? false,
      isImage,
    })

    if (!result.filtered) return undefined

    return {
      content: [{ type: "text", text: result.output }],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        readFilter: {
          strategy: result.strategy,
          originalBytes: result.originalBytes,
          filteredBytes: result.filteredBytes,
        },
      },
    }
  })

  // Tree summary prompt optimizer — keeps branch summaries focused
  pi.on("session_before_tree", async (_event, _ctx) => {
    return {
      customInstructions: COMPACTION_FOCUS_INSTRUCTIONS,
      replaceInstructions: false,
    }
  })
}


export { createArtifactHelperTool } from "./tools/artifact-helper"
export { createWorkflowStateTool } from "./tools/workflow-state"
export { createReviewRouterTool } from "./tools/review-router"
export { createSessionCheckpointTool } from "./tools/session-checkpoint"
export { createTaskSplitterTool } from "./tools/task-splitter"
export { createBrainstormDialogTool } from "./tools/brainstorm-dialog"
export { createPlanDiffTool } from "./tools/plan-diff"
export { createSessionHistoryTool } from "./tools/session-history"
export { createPatternExtractorTool } from "./tools/pattern-extractor"
export { createContextHandoffTool } from "./tools/context-handoff"
export { createMultiReviewerTool } from "./tools/multi-reviewer"
export { createImageDescriptorTool } from "./tools/image-descriptor"
export {
  getBrainstormArtifactPath,
  getPlanArtifactPath,
  getSolutionArtifactPath,
  getRunArtifactPath,
} from "./utils/artifact-paths"
export { normalizeSlug } from "./utils/name-utils"
export { filterBashOutput } from "./tools/bash-output-filter"
export { filterReadOutput } from "./tools/read-output-filter"
export { COMPACTION_FOCUS_INSTRUCTIONS } from "./tools/compaction-optimizer"
