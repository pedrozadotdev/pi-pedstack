import * as childProcess from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import type { JevRequest, JevRuntime } from "../jev/index"
import { classifyVerificationCommand } from "./bash-output-filter"
import {
  applyTriageToContent,
  boundFailureExcerpt,
  buildTriageRequest,
  extractExitCode,
  formatTriageBlock,
  heuristicClassify,
  parseTriageAnswers,
  shouldTriage,
  type RecentChange,
  type TriageRecord,
} from "./failure-triage"
import { persistTriage, type PersistedTriage } from "./triage-store"

// ponytail: one config block — Jev latency cap plus recent-change bounds.
const JEV_TIMEOUT_MS = 2500
const MAX_RECENT_FILES = 20
const MAX_SUMMARY_CHARS = 500

// ponytail: resolve `execFile` lazily through the namespace so test mocks of
// node:child_process that only provide `spawn` do not break module linking.

export interface FailureTriageInput {
  toolName: string
  isError: boolean
  command: string
  stage: string | null
  content: string
}

export type TriageExec = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<string>

export interface FailureTriageDeps {
  runtime: JevRuntime
  repoRoot: string
  cwd: string
  exec?: TriageExec
  now?: () => number
  /** Optional sink for the persisted record, used for handler details. */
  onRecord?: (record: PersistedTriage) => void
  /** Optional sink for a swallowed persistence error (machine-observable). */
  onPersistError?: (error: unknown) => void
}

/** In-process low-clarity streak (advisory signal only; never gates). */
let lowClarityStreak = 0

export function getLowClarityStreak(): number {
  return lowClarityStreak
}

export function resetLowClarityStreak(): void {
  lowClarityStreak = 0
}

async function defaultExec(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const execFile = childProcess.execFile
  if (typeof execFile !== "function") {
    throw new Error("node:child_process.execFile is unavailable")
  }
  const { stdout } = await promisify(execFile)(command, args, {
    cwd,
    timeout: 2000,
    maxBuffer: 1_000_000,
  })
  return String(stdout)
}

/**
 * Read `git diff --name-only HEAD`, capped to 20 files and a 500-char basename
 * summary. Returns `null` on a clean tree or when git is unavailable.
 */
export async function readRecentChange(
  cwd: string,
  exec: TriageExec,
): Promise<RecentChange | null> {
  try {
    const stdout = await exec("git", ["diff", "--name-only", "HEAD"], cwd)
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_RECENT_FILES)
    if (files.length === 0) return null
    const summary = files
      .map((file) => path.basename(file))
      .join(", ")
      .slice(0, MAX_SUMMARY_CHARS)
    return { files, summary }
  } catch {
    return null
  }
}

function recentChangeOf(request: JevRequest): RecentChange | null {
  const state = request.state as { recentChange?: RecentChange | null }
  return state.recentChange ?? null
}

/** Run Jev, degrading to the keyword heuristic on any failure or abstention. */
async function decideOrHeuristic(
  runtime: JevRuntime,
  request: JevRequest,
  excerpt: string,
  cwd: string,
): Promise<TriageRecord | null> {
  try {
    const result = await runtime.decide(request, {
      timeoutMs: JEV_TIMEOUT_MS,
      cwd,
    })
    const parsed = parseTriageAnswers(result, {
      hasRecentChange: recentChangeOf(request) !== null,
    })
    if (parsed.ok) return parsed.triage
  } catch {
    // ponytail: any Jev outage degrades to the deterministic heuristic.
  }

  const heuristic = heuristicClassify(excerpt)
  if (!heuristic) return null
  return {
    category: heuristic.category,
    confidence: heuristic.confidence,
    relatedToRecentChange: "unknown",
    rootCauseClarity: 0,
    source: "heuristic",
  }
}

function updateStreak(
  source: TriageRecord["source"],
  clarity: number,
): { streak: number; signal: boolean } {
  // ponytail: only a Jev clarity judgment counts toward the streak; a heuristic
  // fallback (clarity 0) during a Jev outage is not worker-model flailing.
  if (source === "jev") {
    lowClarityStreak = clarity >= 3 ? 0 : lowClarityStreak + 1
  }
  return { streak: lowClarityStreak, signal: lowClarityStreak >= 3 }
}

async function persistOrSwallow(
  deps: FailureTriageDeps,
  input: FailureTriageInput,
  triage: TriageRecord,
  exitCode: number,
  excerptBytes: number,
): Promise<void> {
  const { streak, signal } = updateStreak(triage.source, triage.rootCauseClarity)
  const record: PersistedTriage = {
    ts: new Date((deps.now ?? Date.now)()).toISOString(),
    command: input.command,
    exitCode,
    stage: input.stage ?? "unknown",
    category: triage.category,
    confidence: triage.confidence,
    relatedToRecentChange: triage.relatedToRecentChange,
    rootCauseClarity: triage.rootCauseClarity,
    source: triage.source,
    lowClarityStreak: streak,
    escalationSignal: signal,
    excerptBytes,
  }

  try {
    await persistTriage(deps.repoRoot, record)
  } catch (error) {
    // ponytail: persistence is best-effort; it never affects the returned text.
    deps.onPersistError?.(error)
  }
  deps.onRecord?.(record)
}

/**
 * Annotate a failed verification result with an advisory triage block.
 * Returns the annotated content text, or `null` to leave the result unchanged.
 * Never throws: any internal bug fails open to `null`.
 */
export async function runFailureTriage(
  input: FailureTriageInput,
  deps: FailureTriageDeps,
): Promise<string | null> {
  try {
    if (!input.isError) {
      if (classifyVerificationCommand(input.command) !== null) {
        resetLowClarityStreak()
      }
      return null
    }

    if (
      !shouldTriage({
        toolName: input.toolName,
        isError: input.isError,
        command: input.command,
        stage: input.stage,
      })
    ) {
      return null
    }

    const bounded = boundFailureExcerpt(input.content)
    const exitCode = extractExitCode(input.content)
    const exec = deps.exec ?? defaultExec
    const recentChange = await readRecentChange(deps.cwd, exec)
    const request = buildTriageRequest({
      command: input.command,
      exitCode,
      stage: input.stage as string,
      excerpt: bounded.excerpt,
      recentChange,
    })

    const triage = await decideOrHeuristic(
      deps.runtime,
      request,
      bounded.excerpt,
      deps.cwd,
    )
    if (!triage) return null

    const block = formatTriageBlock(triage)
    await persistOrSwallow(deps, input, triage, exitCode, bounded.bytes)
    return applyTriageToContent(input.content, block)
  } catch {
    return null
  }
}
