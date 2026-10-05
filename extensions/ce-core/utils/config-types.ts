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

export interface PiPedstackConfig {
  brainstorm?: ReviewableStepConfig
  plan?: ReviewableStepConfig
  work?: StepConfig
  review?: ReviewableStepConfig
  debug?: StepConfig
  learn?: ReviewableStepConfig
  docsync?: StepConfig
  solutionRanking?: SolutionRankingConfig
}

// ---------------------------------------------------------------------------
// Step name mapping
// ---------------------------------------------------------------------------

export type StepConfigKey = Exclude<keyof PiPedstackConfig, "solutionRanking">

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
): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `pi-pedstack config: "solutionRanking.${key}" must be a finite number in [0, 1]`,
    )
  }
  return value
}

function readPositiveInteger(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `pi-pedstack config: "solutionRanking.${key}" must be an integer >= 1`,
    )
  }
  return value
}

function readBooleanField(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") {
    throw new Error(`pi-pedstack config: "solutionRanking.${key}" must be a boolean`)
  }
  return value
}

function warnUnknownSolutionRankingKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!SOLUTION_RANKING_KEYS.has(key)) {
      console.warn(`[pi-pedstack] Unknown solutionRanking key: "${key}"`)
    }
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

  warnUnknownSolutionRankingKeys(obj)

  return result
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
    if (!VALID_STEP_NAMES.has(key) && key !== "solutionRanking") {
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
