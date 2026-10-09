import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type JSONObject = Record<string, unknown>;
export interface LiveSample {
  metadata: JSONObject;
  validation: JSONObject | null;
  rows: JSONObject[];
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function label(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "unknown";
}
function positiveOrZero(value: unknown): number {
  return numeric(value) ?? 0;
}
export function statistics(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    variance: sorted.length < 2 ? null : sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sorted.length - 1),
  };
}

function total(rows: JSONObject[], predicate: (row: JSONObject) => boolean, field: string): number {
  return rows.filter(predicate).reduce((sum, row) => sum + positiveOrZero(row[field]), 0);
}
function elapsed(metadata: JSONObject): number | null {
  if (typeof metadata.startedAt !== "string" || typeof metadata.finishedAt !== "string") return null;
  const start = Date.parse(metadata.startedAt);
  const finish = Date.parse(metadata.finishedAt);
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : null;
}
function sampleMetrics(sample: LiveSample) {
  const rows = sample.rows;
  const stageRows = rows.filter(row => row.event === "stage_end" || row.event === "stage_interrupted");
  const stageMs = total(stageRows, () => true, "durationMs");
  const verification = rows.filter(row => row.event === "verification_execution");
  const jev = rows.filter(row => row.event === "jev_decision");
  const usage = rows.filter(row => row.event === "jev_decision" || row.event === "model_response");
  return {
    sessionElapsedMs: elapsed(sample.metadata),
    activeStageWallMs: stageRows.length ? stageMs : null,
    stageRows,
    jevCalls: jev.filter(row => row.processInvoked === true).length,
    jevProcessMs: total(jev, () => true, "processDurationMs"),
    modelCalls: total(rows, () => true, "modelCalls"),
    providerRequests: total(rows, () => true, "providerRequests"),
    reviewers: total(rows, () => true, "independentReviewers"),
    searches: total(rows, () => true, "searchCalls"),
    duplicateSearches: total(rows, () => true, "repeatSearches"),
    verificationMs: total(verification, () => true, "durationMs"),
    verificationCalls: verification.length,
    stageTransitions: total(rows, () => true, "stageTransitions"),
    repeatedStageEntries: rows.filter(row => row.event === "stage_start" && positiveOrZero(row.repeatAttempt) > 1).length,
    usageResponses: usage.length,
    usageKnown: usage.filter(row => row.usageKnown === true).length,
    inputTokens: total(usage, row => row.usageKnown === true, "inputTokens"),
    outputTokens: total(usage, row => row.usageKnown === true, "outputTokens"),
    costKnown: usage.filter(row => numeric(row.costUsd) !== null).length,
    costUsd: total(usage, () => true, "costUsd"),
  };
}

function runGroupKey(metadata: JSONObject): string {
  return JSON.stringify([
    label(metadata.scenario), label(metadata.revision), label(metadata.model),
    label(metadata.thinkingLevel), label(metadata.configSha256),
    label(metadata.fixtureSha256), label(metadata.runtime),
    label(metadata.operatorDecisionPlanSha256),
  ]);
}

/** All attempts count, including failed, missing or partially instrumented sessions. */
export function summarizeLiveBaseline(samples: LiveSample[], scenarioIds: string[], requiredRuns: number, unreadableRuns = 0) {
  const groups = new Map<string, LiveSample[]>();
  for (const sample of samples) {
    const key = runGroupKey(sample.metadata);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const summaries = [...groups].map(([key, groupSamples]) => {
    const [scenario, revision, model, thinkingLevel, configSha256, fixtureSha256, runtime, operatorDecisionPlanSha256] = JSON.parse(key) as string[];
    const observed = groupSamples.length;
    const valid = groupSamples.filter(sample => sample.validation?.passed === true && sample.metadata.piExitCode === 0).length;
    const metrics = groupSamples.map(sampleMetrics);
    const metric = (field: keyof ReturnType<typeof sampleMetrics>) =>
      statistics(metrics.map(item => item[field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
    const stages = new Map<string, number[]>();
    for (const item of metrics) {
      const stageTotals = new Map<string, number>();
      for (const row of item.stageRows) {
        if (typeof row.stage !== "string" || numeric(row.durationMs) === null) continue;
        stageTotals.set(row.stage, (stageTotals.get(row.stage) ?? 0) + (numeric(row.durationMs) ?? 0));
      }
      for (const [stage, duration] of stageTotals) stages.set(stage, [...(stages.get(stage) ?? []), duration]);
    }
    const usageResponses = metrics.reduce((sum, item) => sum + item.usageResponses, 0);
    const usageKnown = metrics.reduce((sum, item) => sum + item.usageKnown, 0);
    const costKnown = metrics.reduce((sum, item) => sum + item.costKnown, 0);
    return {
      scenario, revision, model, thinkingLevel, configSha256, fixtureSha256, runtime, operatorDecisionPlanSha256,
      requiredRuns, observedRuns: observed, validRuns: valid, failedRuns: observed - valid,
      complete: observed === requiredRuns && valid === requiredRuns,
      // Session wall clock includes user confirmation/idle time; stage wall clock
      // does not. Neither is silently substituted for the other.
      sessionElapsedMs: metric("sessionElapsedMs"),
      activeStageWallMs: metric("activeStageWallMs"),
      stageWallMs: Object.fromEntries([...stages].sort(([a], [b]) => a.localeCompare(b)).map(([stage, values]) => [stage, statistics(values)])),
      jevCalls: metric("jevCalls"),
      jevProcessMs: metric("jevProcessMs"),
      modelCalls: metric("modelCalls"),
      providerRequests: metric("providerRequests"),
      reviewers: metric("reviewers"),
      searches: metric("searches"),
      duplicateSearches: metric("duplicateSearches"),
      verificationMs: metric("verificationMs"),
      verificationCalls: metric("verificationCalls"),
      stageTransitions: metric("stageTransitions"),
      repeatedStageEntries: metric("repeatedStageEntries"),
      usage: {
        knownResponses: usageKnown, totalResponses: usageResponses, unknownResponses: usageResponses - usageKnown,
        inputTokensKnownTotal: usageKnown ? metrics.reduce((sum, item) => sum + item.inputTokens, 0) : null,
        outputTokensKnownTotal: usageKnown ? metrics.reduce((sum, item) => sum + item.outputTokens, 0) : null,
        costKnownResponses: costKnown,
        costUsdKnownTotal: costKnown ? metrics.reduce((sum, item) => sum + item.costUsd, 0) : null,
        partial: usageKnown !== usageResponses || costKnown !== usageResponses,
      },
    };
  });
  const complete = unreadableRuns === 0 &&
    summaries.length === scenarioIds.length &&
    scenarioIds.every(id => summaries.filter(group => group.scenario === id && group.complete).length === 1);
  return {
    schema: 1, requiredRunsPerScenario: requiredRuns, totalDiscoveredRuns: samples.length + unreadableRuns,
    unreadableRuns, complete, scenarios: summaries,
    // A published report must never imply a complete baseline unless all four
    // pinned scenarios have exactly the required samples and every run passes.
    missingScenarios: scenarioIds.filter(id => !summaries.some(group => group.scenario === id && group.complete)),
  };
}

async function collectRunDirectories(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const dirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "workspace" || entry.name === ".git" || entry.name === "node_modules") continue;
    const child = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "metadata.json") dirs.push(root);
    else if (entry.isDirectory()) dirs.push(...await collectRunDirectories(child, depth + 1));
  }
  return [...new Set(dirs)];
}
async function readOptionalJSON(file: string): Promise<JSONObject | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as JSONObject; }
  catch { return null; }
}
async function readRun(dir: string): Promise<LiveSample> {
  const metadata = await readOptionalJSON(path.join(dir, "metadata.json"));
  if (!metadata || typeof metadata.scenario !== "string") throw new Error("missing scenario metadata");
  const validation = await readOptionalJSON(path.join(dir, "validation.json"));
  let rows: JSONObject[] = [];
  try {
    const data = await readFile(path.join(dir, "diagnostics.jsonl"), "utf8");
    rows = data.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as JSONObject);
  } catch {
    // The absent/corrupt telemetry is a failed sample; never omit its metadata.
    return { metadata, validation: null, rows: [] };
  }
  return { metadata, validation, rows };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root || !path.isAbsolute(root)) {
    console.error("Usage: bun docs/benchmarks/issue-62/summarize-live-runs.ts <absolute-runs-root>");
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(await readFile(new URL("./live-scenarios.json", import.meta.url), "utf8")) as {
        scenarios: Array<{ id: string }>; runs: number;
      };
      const directories = await collectRunDirectories(root);
      const results = await Promise.all(directories.map(async dir => {
        try { return await readRun(dir); } catch { return null; }
      }));
      const readable = results.filter((item): item is LiveSample => item !== null);
      const report = summarizeLiveBaseline(readable, manifest.scenarios.map(item => item.id), manifest.runs, results.length - readable.length);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (!report.complete) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize live baseline");
      process.exitCode = 1;
    }
  }
}
