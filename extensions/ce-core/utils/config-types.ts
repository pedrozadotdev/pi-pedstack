import { readFile } from "node:fs/promises"
import path from "node:path"
import * as os from "node:os"
import {
  DEFAULT_SOLUTION_RANKING,
  type RankingThresholds,
  type SolutionRankingConfig,
} from "./solution-ranking"

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface StepConfig {
  model: string
  thinkingLevel?: string
}

export interface ReviewerConfig {
  model: string
  thinkingLevel?: string
}

export interface ReviewableStepConfig extends StepConfig {
  reviewers?: ReviewerConfig[]
}

export interface ModelRolesConfig {
  default?: StepConfig
  review?: StepConfig
  sota?: StepConfig
}

/** Partial, operator-supplied `routing` config block. */
export interface RoutingConfig {
  shadow?: boolean
  sotaMinScore?: number
  sotaMinConfidence?: number
  maxEscalationsPerStage?: number
}

/** Deterministic thresholds that map a Jev judgment to an execution role. */
export interface RoutingThresholds {
  sotaMinScore: number
  sotaMinConfidence: number
  maxEscalationsPerStage: number
}

/** Documented defaults for the `routing` config block (shadow-first). */
export const DEFAULT_MODEL_ROUTING: RoutingThresholds & { shadow: boolean } = {
  sotaMinScore: 0.6,
  sotaMinConfidence: 0.5,
  maxEscalationsPerStage: 1,
  shadow: true,
}

export interface PiPedstackConfig {
  brainstorm?: ReviewableStepConfig
  plan?: ReviewableStepConfig
  work?: StepConfig
  review?: ReviewableStepConfig
  debug?: StepConfig
  learn?: ReviewableStepConfig
  docsync?: StepConfig
  solutionRanking?: SolutionRankingConfig
  semanticRead?: SemanticReadConfig
  models?: ModelRolesConfig
  routing?: RoutingConfig
}

// ---------------------------------------------------------------------------
// Semantic read budgets
// ---------------------------------------------------------------------------

/** Resolved budgets for the semantic read/scout engine (`semantic-file-ask.ts`). */
export interface SemanticBudgets {
  excerptBytes: number
  maxPaths: number
  concurrency: number
  selectLimit: number
  deadlineMs: number
  select: boolean
}

/** Partial, operator-supplied `semanticRead` config block. */
export type SemanticReadConfig = Partial<SemanticBudgets>

export const DEFAULT_SEMANTIC_READ: SemanticBudgets = {
  excerptBytes: 4096,
  maxPaths: 24,
  concurrency: 4,
  selectLimit: 12,
  deadlineMs: 45000,
  select: true,
}

// ---------------------------------------------------------------------------
// Step name mapping
// ---------------------------------------------------------------------------

export type StepConfigKey = Exclude<
  keyof PiPedstackConfig,
  "solutionRanking" | "semanticRead" | "models" | "routing"
>

const SKILL_TO_CONFIG_KEY: Record<string, StepConfigKey> = {
  "01-brainstorm": "brainstorm",
  "02-plan": "plan",
  "03-work": "work",
  "04-review": "review",
  "04-5-debug": "debug",
  "05-learn": "learn",
  "06-docsync": "docsync",
}

const VALID_STEP_NAMES = new Set<string>(Object.values(SKILL_TO_CONFIG_KEY))

export function getConfigKeyForSkill(skillName: string): StepConfigKey | null {
  return SKILL_TO_CONFIG_KEY[skillName] ?? null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isStepConfig(value: unknown): value is StepConfig {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  if (typeof obj.model !== "string") return false
  if (obj.thinkingLevel !== undefined && typeof obj.thinkingLevel !== "string") return false
  return true
}

function isReviewerConfig(value: unknown): value is ReviewerConfig {
  return isStepConfig(value)
}

function isReviewableStepConfig(value: unknown): value is ReviewableStepConfig {
  if (!isStepConfig(value)) return false
  // SAFETY: isStepConfig narrowed value to StepConfig; StepConfig has no index
  // signature, so a double assertion is needed to read its optional keys.
  const obj = value as unknown as Record<string, unknown>
  if (obj.reviewers === undefined) return true
  if (!Array.isArray(obj.reviewers)) return false
  return obj.reviewers.every(isReviewerConfig)
}

const SOLUTION_RANKING_KEYS = new Set([
  "minRank",
  "minConfidence",
  "concurrency",
  "candidates",
  "limit",
  "shadow",
])

function readUnitInterval(
  obj: Record<string, unknown>,
  key: string,
  prefix = "solutionRanking",
): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `pi-pedstack config: "${prefix}.${key}" must be a finite number in [0, 1]`,
    )
  }
  return value
}

function readPositiveInteger(
  obj: Record<string, unknown>,
  key: string,
  prefix = "solutionRanking",
): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `pi-pedstack config: "${prefix}.${key}" must be an integer >= 1`,
    )
  }
  return value
}

function readBooleanField(
  obj: Record<string, unknown>,
  key: string,
  prefix = "solutionRanking",
): boolean | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") {
    throw new Error(`pi-pedstack config: "${prefix}.${key}" must be a boolean`)
  }
  return value
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      console.warn(`[pi-pedstack] Unknown ${prefix} key: "${key}"`)
    }
  }
}

const MODEL_ROLES_KEYS = new Set(["default", "review", "sota"])

function validateModels(raw: unknown): ModelRolesConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('pi-pedstack config: "models" must be an object')
  }

  const obj = raw as Record<string, unknown>
  const result: ModelRolesConfig = {}
  for (const role of ["default", "review", "sota"] as const) {
    if (obj[role] === undefined) continue
    if (!isStepConfig(obj[role])) {
      throw new Error(
        `pi-pedstack config: "models.${role}" must have "model" (string) and optional "thinkingLevel" (string)`,
      )
    }
    result[role] = obj[role] as StepConfig
  }

  warnUnknownKeys(obj, MODEL_ROLES_KEYS, "models")
  return result
}

const ROUTING_KEYS = new Set([
  "shadow",
  "sotaMinScore",
  "sotaMinConfidence",
  "maxEscalationsPerStage",
])

function validateRouting(raw: unknown): RoutingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('pi-pedstack config: "routing" must be an object')
  }

  const obj = raw as Record<string, unknown>
  const result: RoutingConfig = {}
  for (const key of ["sotaMinScore", "sotaMinConfidence"] as const) {
    const value = readUnitInterval(obj, key, "routing")
    if (value !== undefined) result[key] = value
  }
  const maxEscalations = readPositiveInteger(
    obj,
    "maxEscalationsPerStage",
    "routing",
  )
  if (maxEscalations !== undefined) {
    result.maxEscalationsPerStage = maxEscalations
  }
  const shadow = readBooleanField(obj, "shadow", "routing")
  if (shadow !== undefined) result.shadow = shadow

  warnUnknownKeys(obj, ROUTING_KEYS, "routing")
  return result
}

/** Merge a validated (possibly partial) config with the documented defaults. */
export function resolveModelRolesConfig(
  config: PiPedstackConfig | null,
): ModelRolesConfig {
  return config?.models ? { ...config.models } : {}
}

/** Merge a validated (possibly partial) config with the documented defaults. */
export function resolveRoutingConfig(
  config: PiPedstackConfig | null,
): RoutingThresholds & { shadow: boolean } {
  const raw = config?.routing ?? {}
  return {
    sotaMinScore: raw.sotaMinScore ?? DEFAULT_MODEL_ROUTING.sotaMinScore,
    sotaMinConfidence:
      raw.sotaMinConfidence ?? DEFAULT_MODEL_ROUTING.sotaMinConfidence,
    maxEscalationsPerStage:
      raw.maxEscalationsPerStage ?? DEFAULT_MODEL_ROUTING.maxEscalationsPerStage,
    shadow: raw.shadow ?? DEFAULT_MODEL_ROUTING.shadow,
  }
}

function validateSolutionRanking(raw: unknown): SolutionRankingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('pi-pedstack config: "solutionRanking" must be an object')
  }

  const obj = raw as Record<string, unknown>
  const result: SolutionRankingConfig = {}

  for (const key of ["minRank", "minConfidence"] as const) {
    const value = readUnitInterval(obj, key)
    if (value !== undefined) result[key] = value
  }
  for (const key of ["concurrency", "candidates", "limit"] as const) {
    const value = readPositiveInteger(obj, key)
    if (value !== undefined) result[key] = value
  }
  const shadow = readBooleanField(obj, "shadow")
  if (shadow !== undefined) result.shadow = shadow

  warnUnknownKeys(obj, SOLUTION_RANKING_KEYS, "solutionRanking")

  return result
}

const SEMANTIC_READ_KEYS = new Set([
  "excerptBytes",
  "maxPaths",
  "concurrency",
  "selectLimit",
  "deadlineMs",
  "select",
])

function validateSemanticRead(raw: unknown): SemanticReadConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('pi-pedstack config: "semanticRead" must be an object')
  }

  const obj = raw as Record<string, unknown>
  const result: SemanticReadConfig = {}

  for (const key of [
    "excerptBytes",
    "maxPaths",
    "concurrency",
    "selectLimit",
    "deadlineMs",
  ] as const) {
    const value = readPositiveInteger(obj, key, "semanticRead")
    if (value !== undefined) result[key] = value
  }
  const select = readBooleanField(obj, "select", "semanticRead")
  if (select !== undefined) result.select = select

  warnUnknownKeys(obj, SEMANTIC_READ_KEYS, "semanticRead")

  return result
}

/** Merge a validated (possibly partial) config with the documented defaults. */
export function resolveSemanticReadConfig(
  config: PiPedstackConfig | null,
): SemanticBudgets {
  const raw = config?.semanticRead ?? {}
  return {
    excerptBytes: raw.excerptBytes ?? DEFAULT_SEMANTIC_READ.excerptBytes,
    maxPaths: raw.maxPaths ?? DEFAULT_SEMANTIC_READ.maxPaths,
    concurrency: raw.concurrency ?? DEFAULT_SEMANTIC_READ.concurrency,
    selectLimit: raw.selectLimit ?? DEFAULT_SEMANTIC_READ.selectLimit,
    deadlineMs: raw.deadlineMs ?? DEFAULT_SEMANTIC_READ.deadlineMs,
    select: raw.select ?? DEFAULT_SEMANTIC_READ.select,
  }
}

/** Merge a validated (possibly partial) config with the documented defaults. */
export function resolveSolutionRankingConfig(
  config: PiPedstackConfig | null,
): RankingThresholds & { shadow: boolean } {
  const raw = config?.solutionRanking ?? {}
  return {
    minRank: raw.minRank ?? DEFAULT_SOLUTION_RANKING.minRank,
    minConfidence: raw.minConfidence ?? DEFAULT_SOLUTION_RANKING.minConfidence,
    concurrency: raw.concurrency ?? DEFAULT_SOLUTION_RANKING.concurrency,
    candidates: raw.candidates ?? DEFAULT_SOLUTION_RANKING.candidates,
    limit: raw.limit ?? DEFAULT_SOLUTION_RANKING.limit,
    shadow: raw.shadow ?? DEFAULT_SOLUTION_RANKING.shadow,
  }
}

function applySimpleStepConfigs(
  obj: Record<string, unknown>,
  config: PiPedstackConfig,
): void {
  for (const key of ["work", "debug", "docsync"] as const) {
    if (obj[key] === undefined) continue
    if (!isStepConfig(obj[key])) {
      throw new Error(
        `pi-pedstack config: "${key}" must have "model" (string) and optional "thinkingLevel" (string)`,
      )
    }
    config[key] = obj[key] as StepConfig
  }
}

function applyReviewableStepConfigs(
  obj: Record<string, unknown>,
  config: PiPedstackConfig,
): void {
  for (const key of ["brainstorm", "plan", "review", "learn"] as const) {
    if (obj[key] === undefined) continue
    if (!isReviewableStepConfig(obj[key])) {
      throw new Error(
        `pi-pedstack config: "${key}" must have "model" (string), optional "thinkingLevel" (string), and optional "reviewers" array of {model, thinkingLevel}`,
      )
    }
    config[key] = obj[key] as ReviewableStepConfig
  }
}

function warnUnknownConfigKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (
      !VALID_STEP_NAMES.has(key) &&
      key !== "solutionRanking" &&
      key !== "semanticRead" &&
      key !== "models" &&
      key !== "routing"
    ) {
      console.warn(`[pi-pedstack] Unknown config key: "${key}". Valid keys: ${[...VALID_STEP_NAMES].join(", ")}`)
    }
  }
}

export function validatePiPedstackConfig(raw: unknown): PiPedstackConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("pi-pedstack config must be an object")
  }

  const obj = raw as Record<string, unknown>
  const config: PiPedstackConfig = {}

  applySimpleStepConfigs(obj, config)
  applyReviewableStepConfigs(obj, config)

  if (obj.solutionRanking !== undefined) {
    config.solutionRanking = validateSolutionRanking(obj.solutionRanking)
  }

  if (obj.semanticRead !== undefined) {
    config.semanticRead = validateSemanticRead(obj.semanticRead)
  }

  if (obj.models !== undefined) {
    config.models = validateModels(obj.models)
  }

  if (obj.routing !== undefined) {
    config.routing = validateRouting(obj.routing)
  }

  warnUnknownConfigKeys(obj)
  return config
}

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

/**
 * Read pi-pedstack config from:
 * 1. Project-level: {cwd}/.pi/pi-pedstack/config.json (highest priority)
 * 2. Global-level: ~/.pi/pi-pedstack/config.json (fallback)
 */
export async function readPiPedstackConfig(cwd: string): Promise<PiPedstackConfig | null> {
  // Try project-level config
  const projectPath = path.join(cwd, ".pi", "pi-pedstack", "config.json")
  try {
    const content = await readFile(projectPath, "utf8")
    const parsed = JSON.parse(content)
    return validatePiPedstackConfig(parsed)
  } catch {
    // Project config not found, continue to global
  }

  // Fallback to global-level
  const globalPath = path.join(os.homedir(), ".pi", "pi-pedstack", "config.json")
  try {
    const content = await readFile(globalPath, "utf8")
    const parsed = JSON.parse(content)
    return validatePiPedstackConfig(parsed)
  } catch {
    return null
  }
}
