import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TriageRecord } from "./failure-triage"

/** Triage record as persisted to disk (record + command/run context). */
export interface PersistedTriage extends TriageRecord {
  ts: string
  command: string
  exitCode: number
  stage: string
  lowClarityStreak: number
  escalationSignal: boolean
  excerptBytes: number
}

const TRIAGE_DIR = path.join(".context", "compound-engineering", "triage")
const LATEST_FILE = "latest.json"
const HISTORY_FILE = "history.jsonl"
const MAX_HISTORY = 50

function triageDir(repoRoot: string): string {
  return path.join(repoRoot, TRIAGE_DIR)
}

/** ponytail: temp-then-rename atomic write; single in-process writer, no lock. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`
  await writeFile(tmp, data, "utf8")
  await rename(tmp, filePath)
}

/**
 * Persist the latest triage and append it to the capped history.
 * Errors bubble to the caller (the runner swallows them on purpose).
 */
export async function persistTriage(
  repoRoot: string,
  record: PersistedTriage,
): Promise<void> {
  const dir = triageDir(repoRoot)
  await mkdir(dir, { recursive: true })

  await atomicWrite(
    path.join(dir, LATEST_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  await appendHistory(path.join(dir, HISTORY_FILE), record)
}

async function appendHistory(
  historyPath: string,
  record: PersistedTriage,
): Promise<void> {
  await appendFile(historyPath, `${JSON.stringify(record)}\n`, "utf8")

  const content = await readFile(historyPath, "utf8").catch(() => "")
  const lines = content.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length > MAX_HISTORY) {
    await atomicWrite(historyPath, `${lines.slice(-MAX_HISTORY).join("\n")}\n`)
  }
}

/** Read the latest triage record, or `null` when missing/corrupt. */
export async function readLatestTriage(
  repoRoot: string,
): Promise<PersistedTriage | null> {
  return readJson<PersistedTriage>(path.join(triageDir(repoRoot), LATEST_FILE))
}

/** Read the persisted history, skipping corrupt lines. */
export async function readTriageHistory(
  repoRoot: string,
): Promise<PersistedTriage[]> {
  let content: string
  try {
    content = await readFile(path.join(triageDir(repoRoot), HISTORY_FILE), "utf8")
  } catch {
    return []
  }

  const entries: PersistedTriage[] = []
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as PersistedTriage)
    } catch {
      // ponytail: skip one corrupt line rather than discarding the history.
    }
  }
  return entries
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T
  } catch {
    return null
  }
}
