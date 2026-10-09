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
any confirmation. A declined transition stays a successful handoff with no
stage transition count. A successful, non-skipped `06-docsync` stage-gate accept
marks the workflow complete; an active stage is marked interrupted if the
session shuts down. Token and cost completeness uses only
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

`live-scenarios.json` pins four workflow tasks, entry commands, stage traces,
review outcomes, and operator decisions. Each task has a checked-in fixture
under `fixtures/`; the runner copies it into a disposable workspace and starts
the extension from the revision being measured. Capture a Pi session with
local diagnostics using:

```sh
bash docs/benchmarks/issue-62/run-live.sh clean-pipeline openai/<model-id> /tmp/issue-62/clean-pipeline-01
```

The runner prints the scenario's exact `/ped-start` or `/ped-debug` command,
opens Pi with diagnostics enabled, and saves the raw JSONL, compact report,
revision, model, runtime, config hash, and final fixture-tree hash. Its
validator checks the recorded stage trace, actual transition count, terminal
completion, review outcomes, checkpoint, SOTA selection, and verification
outcomes required by that scenario. It writes an artifact-tree hash, a hash of
the pinned operator-decision plan, and a hash of the observed workflow
decisions to `validation.json`. Enter the printed command, finish the scenario,
then repeat with the identical fixture and decisions. Run one
unrecorded warmup and 20 recorded runs for each scenario on the instrumented
baseline revision and each candidate. Keep the output folders private because
they contain local workflow measurements and task metadata.

The offline batches are supplemental regression checks; they do not satisfy
Issue #62's live workflow baseline. The original `f39d684` predates diagnostics
and cannot produce comparable live JSONL. Use the instrumented PR revision as
the pre-optimization baseline for later changes, with a candidate-specific
worktree and the same fixture, model/provider, thinking level, routing and
feature configuration, artifacts, and operator decisions. Record one warmup
and at least 20 sequential runs per scenario; preserve every diagnostics file,
report, and validation result. Live usage/cost is present only when the model or
Jev response exposes it; never infer it from duration. The resume case must use
the same saved checkpoint/handoff input, and escalation must use the same
explicit eligible-stage routing configuration. The live run data is still
pending, so Issue #62 must remain open until those artifacts are captured.
