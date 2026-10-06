import type { JevRequest, JevResult } from "../jev/index"
import { classifyVerificationCommand } from "./bash-output-filter"

// ============================================================================
// Types
// ============================================================================

/** Failure categories, names verbatim from the brainstorm taxonomy. */
export type TriagedCategory =
  | "implementation_bug"
  | "test_fixture"
  | "environment_toolchain"
  | "dependency_config"
  | "flaky_timing"
  | "external_service"
  | "unknown"

export type TriageSource = "jev" | "heuristic" | "skipped"

export interface TriageRecord {
  category: TriagedCategory
  confidence: number
  relatedToRecentChange: boolean | "unknown"
  rootCauseClarity: number
  source: TriageSource
}

export interface TriageTriggerInput {
  toolName: string
  isError: boolean
  command: string
  stage: string | null
}

export interface RecentChange {
  files: string[]
  summary: string
}

export interface TriageRequestInput {
  command: string
  exitCode: number
  stage: string
  excerpt: string
  recentChange: RecentChange | null
}

export interface BoundedExcerpt {
  excerpt: string
  bytes: number
  truncated: boolean
}

export type TriageParse =
  | { ok: true; triage: TriageRecord }
  | { ok: false; reason: string }

export interface HeuristicTriage {
  category: TriagedCategory
  confidence: number
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_EXCERPT_BYTES = 8192
export const MAX_EXCERPT_LINES = 120
export const MAX_INLINE_CHARS = 400

/** Only these stages run failure triage (brainstorm/plan/review/docsync no-op). */
const TRIAGE_STAGES = new Set(["03-work", "04-5-debug"])

const MAX_HEAD_LINES = 20
const MAX_TAIL_LINES = 20

const EXIT_CODE_PATTERN = /Command exited with code (\d+)/

// ponytail: static category -> one-line hint map; no dynamic lookup needed.
const CATEGORY_HINTS: Record<TriagedCategory, string> = {
  implementation_bug: "Compare product code behavior against the spec or intent.",
  test_fixture: "Check the test, expectation, or fixture before changing product code.",
  environment_toolchain: "Verify the toolchain: binary on PATH, runtime version, permissions.",
  dependency_config: "Check package versions, lockfile, and config/build settings.",
  flaky_timing: "Re-run in isolation; look for ordering, timing, or race dependence.",
  external_service: "Check external dependency availability (network/API/DB/container).",
  unknown: "Evidence insufficient; gather a tighter signal before hypothesizing.",
}

// ponytail: ordered first-match keyword rules; environment/dependency outrank
// ambiguous categories, matching the brainstorm precedence.
const HEURISTIC_RULES: Array<{ category: TriagedCategory; patterns: RegExp[] }> = [
  {
    category: "environment_toolchain",
    patterns: [
      /command not found/i,
      /is not recognized as/i,
      /permission denied/i,
      /\bEACCES\b|\bEPERM\b/,
      /no such file or directory/i,
      /\bENOENT\b/,
      /\bENOSPC\b/,
    ],
  },
  {
    category: "dependency_config",
    patterns: [
      /cannot find module/i,
      /module not found/i,
      /\bERR_MODULE_NOT_FOUND\b/,
      /cannot resolve/i,
      /peer dep/i,
      /lockfile/i,
      /\bERESOLVE\b/,
    ],
  },
  {
    category: "external_service",
    patterns: [
      /\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bECONNRESET\b/,
      /network error/i,
      /connection refused/i,
      /\b50[234]\b/,
    ],
  },
  {
    category: "flaky_timing",
    patterns: [
      /\btimed out\b/i,
      /\btimeout\b/i,
      /\bflaky\b/i,
      /race condition/i,
      /\bintermittent\b/i,
    ],
  },
  {
    category: "test_fixture",
    patterns: [
      /expected .* received/i,
      /\bassertion/i,
      /snapshot/i,
      /\bfixture\b/i,
      /\btoBe\b|\btoEqual\b|\btoMatch\b/,
    ],
  },
  {
    category: "implementation_bug",
    patterns: [
      /\bTypeError\b|\bReferenceError\b|\bRangeError\b/,
      /undefined is not/i,
      /is not a function/i,
      /null pointer/i,
    ],
  },
]

const SIGNAL_PATTERNS: RegExp[] = [
  /\bFAIL(?:ED|ING)?\b/i,
  /\bError\b/,
  /error TS\d+/,
  /expected .* received/i,
  /[✗✘✕×]/,
  /\bpanic\b/i,
  /\bassert/i,
  /\bE2E\b/,
]

/** Stack-location / failing-identifier lines, e.g. `src/foo.ts:12:3`. */
const IDENTIFIER_PATTERN = /\S+\.\w+:\d+(?::\d+)?/

const TRIAGE_CATEGORIES: TriagedCategory[] = [
  "implementation_bug",
  "test_fixture",
  "environment_toolchain",
  "dependency_config",
  "flaky_timing",
  "external_service",
  "unknown",
]

const CATEGORY_CRITERIA: Record<string, string> = {
  implementation_bug: "Product code behavior contradicts spec or intent.",
  test_fixture: "Test harness, expectation, or fixture is wrong or stale.",
  environment_toolchain: "Missing binary, wrong runtime, PATH, OS, or permissions.",
  dependency_config: "Package version, lockfile, config, or build-config mismatch.",
  flaky_timing: "Nondeterministic, ordering, timing, or race-dependent failure.",
  external_service: "Network, API, DB, or container dependency unavailable.",
  unknown: "Evidence is insufficient to separate causes.",
}

const CLARITY_CRITERIA: string[] = [
  "0 - no signal or opaque output",
  "1 - weak signal",
  "2 - weak, single plausible area",
  "3 - plausible single cause",
  "4 - strong localization",
  "5 - explicit stack or failing assertion points at the cause",
]

// ============================================================================
// Trigger + extraction
// ============================================================================

/** Gate: bash + failing + verification command + triage stage. */
export function shouldTriage(input: TriageTriggerInput): boolean {
  if (input.toolName !== "bash") return false
  if (!input.isError) return false
  if (classifyVerificationCommand(input.command) === null) return false
  return input.stage !== null && TRIAGE_STAGES.has(input.stage)
}

/** Recover the exit code from pi's `Command exited with code N` suffix. */
export function extractExitCode(text: string): number {
  const match = EXIT_CODE_PATTERN.exec(text)
  if (!match) return 1
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : 1
}

function trimToBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf-8") <= max) return text
  let end = Math.min(text.length, max)
  let candidate = text.slice(0, end)
  while (Buffer.byteLength(candidate, "utf-8") > max && end > 0) {
    end = Math.floor(end * 0.9)
    candidate = text.slice(0, end)
  }
  return candidate
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

/**
 * Bound a failure log to <= 8 KB / 120 lines. Extraction order: signal lines,
 * failing identifiers, then head <= 20 + tail <= 20 lines. A short input is
 * returned unchanged.
 */
export function boundFailureExcerpt(output: string): BoundedExcerpt {
  const lines = output.split("\n")
  const bytes = Buffer.byteLength(output, "utf-8")
  if (bytes <= MAX_EXCERPT_BYTES && lines.length <= MAX_EXCERPT_LINES) {
    return { excerpt: output, bytes, truncated: false }
  }

  const signals = lines.filter((line) =>
    SIGNAL_PATTERNS.some((pattern) => pattern.test(line)),
  )
  const identifiers = lines.filter((line) => IDENTIFIER_PATTERN.test(line))
  const head = lines.slice(0, MAX_HEAD_LINES)
  const tail = lines.slice(-MAX_TAIL_LINES)

  const ordered = dedupe([...signals, ...identifiers, ...head, ...tail])
  const cappedLines = ordered.slice(0, MAX_EXCERPT_LINES)
  const excerpt = trimToBytes(cappedLines.join("\n"), MAX_EXCERPT_BYTES)

  return {
    excerpt,
    bytes: Buffer.byteLength(excerpt, "utf-8"),
    truncated: true,
  }
}

// ============================================================================
// Jev request + answer parsing
// ============================================================================

/** Build the Jev request; field names mirror the brainstorm schema verbatim. */
export function buildTriageRequest(input: TriageRequestInput): JevRequest {
  const excerpt = trimToBytes(input.excerpt, MAX_EXCERPT_BYTES)
  return {
    state: {
      command: input.command,
      exitCode: input.exitCode,
      stage: input.stage,
      excerpt,
      recentChange: input.recentChange,
    },
    questions: {
      category: {
        type: "choice",
        instructions:
          "Classify the failed verification command. Choose unknown when the excerpt does not support a category.",
        criteria: CATEGORY_CRITERIA,
      },
      related_to_recent_change: {
        type: "noul",
        instructions:
          "Does the failure relate to the listed recent change? Answer false when uncertain or when there is no change.",
        criteria: {
          true: "The failure is plausibly caused by the recent change.",
          false: "The failure is unrelated to the recent change or evidence is insufficient.",
        },
      },
      root_cause_clarity: {
        type: "score",
        instructions:
          "Score how sharply the excerpt localizes the root cause, from 0 (opaque) to 5 (explicit).",
        criteria: CLARITY_CRITERIA,
      },
    },
  }
}

function isTriagedCategory(value: unknown): value is TriagedCategory {
  return (
    typeof value === "string" &&
    (TRIAGE_CATEGORIES as string[]).includes(value)
  )
}

/** Parse the three Jev answers into a triage record or a typed failure. */
export function parseTriageAnswers(
  result: JevResult,
  opts: { hasRecentChange: boolean },
): TriageParse {
  const categoryAnswer = result.answers.category
  if (!categoryAnswer || categoryAnswer.type !== "choice") {
    return { ok: false, reason: "missing category answer" }
  }
  if (!isTriagedCategory(categoryAnswer.choice)) {
    return { ok: false, reason: `unknown category: ${categoryAnswer.choice}` }
  }

  const relatedAnswer = result.answers.related_to_recent_change
  if (!relatedAnswer || relatedAnswer.type !== "noul") {
    return { ok: false, reason: "missing related_to_recent_change answer" }
  }

  const clarityAnswer = result.answers.root_cause_clarity
  if (!clarityAnswer || clarityAnswer.type !== "score") {
    return { ok: false, reason: "missing root_cause_clarity answer" }
  }

  const clarity = Math.max(0, Math.min(5, Math.round(clarityAnswer.score)))
  const relatedToRecentChange: boolean | "unknown" = opts.hasRecentChange
    ? relatedAnswer.noul >= 0.5
    : "unknown"

  return {
    ok: true,
    triage: {
      category: categoryAnswer.choice,
      confidence: categoryAnswer.confidence,
      relatedToRecentChange,
      rootCauseClarity: clarity,
      source: "jev",
    },
  }
}

// ============================================================================
// Heuristic fallback + formatting
// ============================================================================

/** Keyword-based fallback. Returns null (abstain) when nothing matches. */
export function heuristicClassify(excerpt: string): HeuristicTriage | null {
  for (const rule of HEURISTIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(excerpt))) {
      return { category: rule.category, confidence: 0.3 }
    }
  }
  return null
}

function sourceLabel(source: TriageSource): string {
  if (source === "jev") return "Jev"
  if (source === "heuristic") return "heuristic"
  return "skipped"
}

/** Format the compact advisory block, hard-capped to 400 characters. */
export function formatTriageBlock(triage: TriageRecord): string {
  const label = sourceLabel(triage.source)
  const related =
    triage.relatedToRecentChange === "unknown"
      ? "unknown"
      : String(triage.relatedToRecentChange)
  const header =
    `TRIAGE (advisory, ${label}): category=${triage.category} ` +
    `(${triage.confidence.toFixed(2)}) · related_to_change=${related} · ` +
    `clarity=${triage.rootCauseClarity}/5 · source=${triage.source}`
  const block = `${header}\nHint: ${CATEGORY_HINTS[triage.category]}`
  return block.length <= MAX_INLINE_CHARS
    ? block
    : block.slice(0, MAX_INLINE_CHARS)
}

/** Append-only annotation: the original content stays a byte-for-byte prefix. */
export function applyTriageToContent(content: string, block: string): string {
  return `${content}\n\n${block}`
}
