import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { readPiPedstackConfig, getConfigKeyForSkill } from "../utils/config-types"

export interface ReviewerConfig {
  model: string
  thinkingLevel: string
}

export interface MultiReviewerInput {
  stepName: string
  primaryOutput: string
  repoRoot: string
}

export interface ReviewFinding {
  severity: "high" | "moderate" | "low"
  summary: string
  evidence: string
  recommendedAction: string
  relatedPlanUnit?: string
  relatedLearning?: string
  reviewer?: string
  autofixable?: boolean
  autofixApplied?: boolean
  autofixSummary?: string
}

export interface MultiReviewerResult {
  findings: ReviewFinding[]
  compiledSummary: string
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: "pi", args }
}

function extractFindings(text: string, defaultReviewerName: string): ReviewFinding[] {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/)
  const jsonStr = match ? match[1] : text

  try {
    const parsed = JSON.parse(jsonStr.trim())
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => ({
        severity: (item.severity === "high" || item.severity === "moderate" || item.severity === "low") ? item.severity : "low",
        summary: String(item.summary || ""),
        evidence: String(item.evidence || ""),
        recommendedAction: String(item.recommendedAction || item.recommended_action || ""),
        relatedPlanUnit: item.relatedPlanUnit ? String(item.relatedPlanUnit) : undefined,
        relatedLearning: item.relatedLearning ? String(item.relatedLearning) : undefined,
        reviewer: item.reviewer ? String(item.reviewer) : defaultReviewerName,
        autofixable: !!item.autofixable,
      }))
    }
  } catch {
    const startIdx = text.indexOf("[")
    const endIdx = text.lastIndexOf("]")
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      try {
        const fallbackParsed = JSON.parse(text.slice(startIdx, endIdx + 1))
        if (Array.isArray(fallbackParsed)) {
          return fallbackParsed.map((item: any) => ({
            severity: (item.severity === "high" || item.severity === "moderate" || item.severity === "low") ? item.severity : "low",
            summary: String(item.summary || ""),
            evidence: String(item.evidence || ""),
            recommendedAction: String(item.recommendedAction || item.recommended_action || ""),
            relatedPlanUnit: item.relatedPlanUnit ? String(item.relatedPlanUnit) : undefined,
            relatedLearning: item.relatedLearning ? String(item.relatedLearning) : undefined,
            reviewer: item.reviewer ? String(item.reviewer) : defaultReviewerName,
            autofixable: !!item.autofixable,
          }))
        }
      } catch {
        // ignore fallback failure
      }
    }
  }
  return []
}

async function runReviewerProcess(
  reviewer: ReviewerConfig,
  index: number,
  primaryOutput: string,
  repoRoot: string,
  stepName: string,
): Promise<ReviewFinding[]> {
  const reviewerName = `Reviewer #${index + 1} (${reviewer.model})`

  let normalizedKey = stepName.trim().toLowerCase()
  if (normalizedKey.startsWith("0")) {
    const mapped = getConfigKeyForSkill(normalizedKey)
    if (mapped) normalizedKey = mapped
  }

  let role = "You are a professional peer reviewer."
  let task = "Your task is to perform a critical review of the provided artifact/work output."
  let evidenceDesc = "specific quote or section of the artifact"

  if (normalizedKey === "brainstorm") {
    role = "You are a product owner and systems architect design validator."
    task = "Your task is to analyze the requirements discovery / brainstorm artifact. Check for ambiguity, boundary cases, unstated assumptions, and architecture feasibility."
    evidenceDesc = "quote or section in the requirements document"
  } else if (normalizedKey === "plan") {
    role = "You are a principal engineer and planning validator."
    task = "Your task is to analyze the proposed implementation plan. Check for completeness, correct ordering of units, library/API documentation validation notes, and TDD enforcement."
    evidenceDesc = "quote or section in the plan document"
  } else if (normalizedKey === "review") {
    role = "You are a senior code review and verification validator."
    task = "Your task is to analyze the review findings report. Check if findings are sound, evidence is cited correctly, and verification steps are clear and complete."
    evidenceDesc = "finding description or evidence cited"
  } else if (normalizedKey === "learn") {
    role = "You are a knowledge manager and solution card validator."
    task = "Your task is to analyze the proposed learning / solution card. Check if context, categories, tags, overlap rules, and search strategy are correctly defined."
    evidenceDesc = "quote or section in the solution card"
  }

  const systemPrompt = `${role} ${task}
Compile a list of findings following this JSON schema:
[
  {
    "severity": "high" | "moderate" | "low",
    "summary": "one-line description",
    "evidence": "${evidenceDesc}",
    "recommendedAction": "what should be done to address the finding",
    "reviewer": "${reviewerName}",
    "autofixable": false
  }
]
Format your response as a JSON array of findings wrapped in a markdown code block. Do not output anything else.`

  const args: string[] = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", reviewer.model,
    "--thinking", reviewer.thinkingLevel,
    "--system-prompt", systemPrompt,
    `Review the following artifact/work output:\n\n${primaryOutput}`,
  ]

  return new Promise<ReviewFinding[]>((resolve) => {
    const invocation = getPiInvocation(args)
    const isWin = process.platform === "win32"
    const useShell = isWin && invocation.command === "pi"

    const proc = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let buffer = ""

    const processLine = (line: string) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        if (event.type === "message_end" && event.message) {
          const content = event.message.content
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "text") {
                stdout += part.text
              }
            }
          }
        }
      } catch {
        // Not a JSON event or malformed line
      }
    }

    proc.stdout.on("data", (data) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      for (const line of lines) {
        processLine(line)
      }
    })

    proc.on("close", (code) => {
      if (buffer.trim()) {
        processLine(buffer)
      }

      if (code !== 0) {
        console.warn(`[multi-reviewer] Reviewer process ${index + 1} exited with code ${code}`)
      }

      const findings = extractFindings(stdout, reviewerName)
      resolve(findings)
    })

    proc.on("error", (err) => {
      console.error(`[multi-reviewer] Failed to start reviewer process ${index + 1}:`, err)
      resolve([])
    })
  })
}

export function createMultiReviewerTool() {
  return {
    name: "multi_reviewer",
    async execute(input: MultiReviewerInput): Promise<MultiReviewerResult> {
      let reviewers: ReviewerConfig[] | undefined

      // Read configuration automatically
      const config = await readPiPedstackConfig(input.repoRoot)
      let configKey = input.stepName
      if (configKey.startsWith("0")) {
        const mappedKey = getConfigKeyForSkill(configKey)
        if (mappedKey) {
          configKey = mappedKey
        }
      }
      const stageConfig = config ? (config as any)[configKey] : null
      if (stageConfig && Array.isArray(stageConfig.reviewers) && stageConfig.reviewers.length > 0) {
        reviewers = stageConfig.reviewers
      }

      if (!reviewers || reviewers.length === 0) {
        return {
          findings: [],
          compiledSummary: "No reviewers configured.",
        }
      }

      // Run all reviewer processes concurrently
      const promises = reviewers.map((reviewer, idx) =>
        runReviewerProcess(reviewer, idx, input.primaryOutput, input.repoRoot, input.stepName),
      )

      const allFindingsArrays = await Promise.all(promises)
      const findings = allFindingsArrays.flat()

      // Compile markdown summary of findings
      let summary = `# Multi-Model Review Summary\n\n`
      summary += `We ran the review across ${reviewers.length} reviewer model(s). `
      summary += `A total of ${findings.length} finding(s) were flagged.\n\n`

      const high = findings.filter((f) => f.severity === "high")
      const moderate = findings.filter((f) => f.severity === "moderate")
      const low = findings.filter((f) => f.severity === "low")

      if (high.length > 0) {
        summary += `## 🔴 High Severity (${high.length})\n\n`
        for (const f of high) {
          summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`
          summary += `  - *Evidence*: \`${f.evidence}\`\n`
          summary += `  - *Recommendation*: ${f.recommendedAction}\n`
        }
        summary += `\n`
      }

      if (moderate.length > 0) {
        summary += `## 🟡 Moderate Severity (${moderate.length})\n\n`
        for (const f of moderate) {
          summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`
          summary += `  - *Evidence*: \`${f.evidence}\`\n`
          summary += `  - *Recommendation*: ${f.recommendedAction}\n`
        }
        summary += `\n`
      }

      if (low.length > 0) {
        summary += `## 🟢 Low Severity (${low.length})\n\n`
        for (const f of low) {
          summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`
          summary += `  - *Evidence*: \`${f.evidence}\`\n`
          summary += `  - *Recommendation*: ${f.recommendedAction}\n`
        }
        summary += `\n`
      }

      if (findings.length === 0) {
        summary += `### ✅ No issues identified.\n`
      }

      return {
        findings,
        compiledSummary: summary.trim(),
      }
    },
  }
}
