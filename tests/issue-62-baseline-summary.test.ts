import { describe, expect, test } from "bun:test";
import { statistics, summarizeLiveBaseline, type LiveSample } from "../docs/benchmarks/issue-62/summarize-live-runs";

function sample(scenario: string, opts: { success?: boolean; model?: string; missingUsage?: boolean } = {}): LiveSample {
  return {
    metadata: {
      scenario, revision: "instrumented-commit", model: opts.model ?? "provider/cheap",
      thinkingLevel: "medium", configSha256: "fixed-config", fixtureSha256: "fixed-fixture",
      runtime: "bun", operatorDecisionPlanSha256: "fixed-decisions", piExitCode: opts.success === false ? 1 : 0,
      startedAt: "2026-10-09T12:00:00.000Z", finishedAt: "2026-10-09T12:00:06.000Z",
    },
    validation: { passed: opts.success !== false },
    rows: [
      { stage: "01-brainstorm", event: "stage_end", durationMs: 1200 },
      { stage: "02-plan", event: "stage_end", durationMs: 1500 },
      { stage: "02-plan", event: "jev_decision", processInvoked: true, processDurationMs: 300, usageKnown: !opts.missingUsage, inputTokens: 10, outputTokens: 5 },
      { stage: "02-plan", event: "provider_request", providerRequests: 1, modelCalls: 1 },
      { stage: "02-plan", event: "model_response", usageKnown: true, inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      { stage: "03-work", event: "verification_execution", durationMs: 400, outcome: "success" },
    ],
  };
}

describe("live baseline aggregation", () => {
  test("reports sample median, p95 and sample variance without excluding bad runs", () => {
    expect(statistics([1, 2, 3, 10])).toEqual({ samples: 4, median: 2.5, p95: 10, variance: 50 / 3 });
    const report = summarizeLiveBaseline([
      sample("clean-pipeline"), sample("clean-pipeline", { success: false }),
    ], ["clean-pipeline"], 2);
    expect(report.complete).toBe(false);
    expect(report.scenarios[0]).toMatchObject({
      observedRuns: 2, validRuns: 1, failedRuns: 1, complete: false,
      sessionElapsedMs: { median: 6000 }, activeStageWallMs: { median: 2700 },
      jevCalls: { median: 1 }, verificationMs: { median: 400 },
    });
  });

  test("preserves unknown usage instead of guessing tokens and cost", () => {
    const report = summarizeLiveBaseline([sample("clean-pipeline", { missingUsage: true })], ["clean-pipeline"], 1);
    expect(report.complete).toBe(true);
    expect(report.scenarios[0]?.usage).toMatchObject({
      knownResponses: 1, totalResponses: 2, unknownResponses: 1,
      inputTokensKnownTotal: 100, outputTokensKnownTotal: 20,
      costUsdKnownTotal: 0.01, partial: true,
    });
  });

  test("rejects inadequate samples, mixed configurations and unreadable sessions", () => {
    expect(summarizeLiveBaseline([sample("clean-pipeline")], ["clean-pipeline", "debug-verify"], 1).complete).toBe(false);
    const mixed = summarizeLiveBaseline([
      sample("clean-pipeline"), sample("clean-pipeline", { model: "provider/strong" }),
    ], ["clean-pipeline"], 2);
    expect(mixed.complete).toBe(false);
    expect(mixed.scenarios).toHaveLength(2);
    expect(summarizeLiveBaseline([sample("clean-pipeline")], ["clean-pipeline"], 1, 1).complete).toBe(false);
  });
});
