import { readFile } from "node:fs/promises"
import path from "node:path"
import * as os from "node:os"

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface StepConfig {
  model: string
  thinkingLevel: string
}

export interface ReviewerConfig {
  model: string
  thinkingLevel: string
}

export interface ReviewableStepConfig extends StepConfig {
  reviewers?: ReviewerConfig[]
}

export interface PiPedstackConfig {
  imageDescriptor?: StepConfig
  brainstorm?: ReviewableStepConfig
  plan?: ReviewableStepConfig
  work?: StepConfig
  review?: ReviewableStepConfig
  debug?: StepConfig
  learn?: ReviewableStepConfig
  docsync?: StepConfig
}

// ---------------------------------------------------------------------------
// Step name mapping
// ---------------------------------------------------------------------------

const SKILL_TO_CONFIG_KEY: Record<string, keyof PiPedstackConfig> = {
  "01-brainstorm": "brainstorm",
  "02-plan": "plan",
  "03-work": "work",
  "04-review": "review",
  "04-5-debug": "debug",
  "05-learn": "learn",
  "06-docsync": "docsync",
}

const VALID_STEP_NAMES = new Set<string>(Object.values(SKILL_TO_CONFIG_KEY))

export function getConfigKeyForSkill(skillName: string): keyof PiPedstackConfig | null {
  return SKILL_TO_CONFIG_KEY[skillName] ?? null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isStepConfig(value: unknown): value is StepConfig {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return typeof obj.model === "string" && typeof obj.thinkingLevel === "string"
}

function isReviewerConfig(value: unknown): value is ReviewerConfig {
  return isStepConfig(value)
}

function isReviewableStepConfig(value: unknown): value is ReviewableStepConfig {
  if (!isStepConfig(value)) return false
  const obj = value as unknown as Record<string, unknown>
  if (obj.reviewers === undefined) return true
  if (!Array.isArray(obj.reviewers)) return false
  return obj.reviewers.every(isReviewerConfig)
}

export function validatePiPedstackConfig(raw: unknown): PiPedstackConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("pi-pedstack config must be an object")
  }

  const obj = raw as Record<string, unknown>
  const config: PiPedstackConfig = {}

  // Simple step configs (no reviewers)
  for (const key of ["imageDescriptor", "work", "debug", "docsync"] as const) {
    if (obj[key] !== undefined) {
      if (!isStepConfig(obj[key])) {
        throw new Error(
          `pi-pedstack config: "${key}" must have "model" (string) and "thinkingLevel" (string)`,
        )
      }
      config[key] = obj[key] as StepConfig
    }
  }

  // Reviewable step configs
  for (const key of ["brainstorm", "plan", "review", "learn"] as const) {
    if (obj[key] !== undefined) {
      if (!isReviewableStepConfig(obj[key])) {
        throw new Error(
          `pi-pedstack config: "${key}" must have "model" (string), "thinkingLevel" (string), and optional "reviewers" array of {model, thinkingLevel}`,
        )
      }
      config[key] = obj[key] as ReviewableStepConfig
    }
  }

  // Warn about unknown keys
  for (const key of Object.keys(obj)) {
    if (!VALID_STEP_NAMES.has(key) && key !== "imageDescriptor") {
      console.warn(`[pi-pedstack] Unknown config key: "${key}". Valid keys: ${[...VALID_STEP_NAMES, "imageDescriptor"].join(", ")}`)
    }
  }

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
