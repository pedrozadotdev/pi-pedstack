# Issue #62 local measurement

Diagnostics are disabled by default. To capture one local run, set
`PEDSTACK_DIAGNOSTICS_FILE` to an absolute JSONL path before launching Pi:

```sh
PEDSTACK_DIAGNOSTICS_FILE=/tmp/pedstack-run.jsonl pi
```

Afterward, print a compact per-stage and per-feature report:

```sh
bun extensions/ce-core/diagnostics-report.ts /tmp/pedstack-run.jsonl
```

Compare a candidate run with a saved baseline:

```sh
bun extensions/ce-core/diagnostics-report.ts /tmp/baseline.jsonl --compare /tmp/candidate.jsonl
```

The output includes median, nearest-rank p95, sample variance, Jev subprocess
calls and duration, selected execution roles, model request counts and exposed
input/output tokens and cost, provider response-header latency, reviewer counts,
repeated stage entries, repeated solution searches, successful transitions,
tool durations, outcomes, and fixed event counts (including separate automatic
and manual solution searches and verification calls).
Missing usage and cost stay `unknown`; a partially measured group says so.
Model and tool durations overlap with total stage time and must not be added
to estimate total elapsed time. Diagnostic files contain only enumerated labels,
numeric measurements, opaque run/episode ids and outcomes. Keep them local.
Provider response latency measures request-to-response-headers; it excludes
stream consumption and token generation after headers. Full stage wall time
includes that remaining wait. A saved handoff is recorded separately; its
transition is counted only when the destination stage actually starts after
any confirmation. A declined transition stays interrupted. A successful final
`06-docsync` save marks the workflow complete; an active stage is marked
interrupted if the session shuts down. Token and cost completeness uses only
usage-capable `model_response` and `jev_decision` rows, not request/response
latency observations.

`scenarios.json` pins four offline regression batches and safety invariants.
`baseline-main.json` records the unmodified main baseline at
`f39d6845d309e540a8198215668f31ead0d13d0e`: one warmup and twenty sequential
runs per batch on Bun 1.4.2 / Pi 0.80.10. Those timings cover Bun startup and
the named tests. They do not measure live model or complete workflow latency.
`candidate-offline.json` and `comparison.md` preserve the matching candidate
run, all raw samples, and a source-tree fingerprint.
To compare later code, rerun each exact command from the manifest on the same
machine and runtime, preserve all 20 raw times, and use median, nearest-rank p95
and sample variance (for even sample counts, median averages the two middle
values). Run the full pinned batches; don't compare partial outputs.

`live-scenarios.json` defines the four real workflow paths and their expected
stage traces. Capture one Pi session with local diagnostics using:

```sh
bash docs/benchmarks/issue-62/run-live.sh clean-pipeline openai/<model-id> /tmp/issue-62/clean-pipeline-01
```

The runner prints the exact `/ped-start` input, opens Pi with diagnostics
enabled, and saves the raw JSONL, compact report, revision, model, runtime, and
Pedstack config hash. Enter the printed command, finish the scenario, then
repeat with the identical fixture and decisions. Run one unrecorded warmup and
20 recorded runs for each scenario on both revisions. Keep the output folders
private because they contain local workflow measurements and task metadata.

The offline batches are supplemental regression checks; they do not satisfy
Issue #62's live workflow baseline. That baseline remains pending until each
workflow path below has repeatable task inputs and measurements from both the
baseline and candidate revisions. Keep the issue open until those artifacts
exist. For live before/after comparisons, use isolated disposable repositories
at both revisions and keep model/provider, thinking level, routing and feature
configuration, artifacts, and operator decisions constant. Record revision and
configuration hashes, one warmup, then at least 20 sequential runs per scenario.
Preserve each diagnostics JSONL file and its report. Live usage/cost is present
only when the model or Jev response exposes it; never infer it from duration.
The resume case must use the same saved checkpoint/handoff input, and escalation
must use the same explicit eligible-stage routing configuration.
