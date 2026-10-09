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
tool durations, and outcomes.
Missing usage and cost stay `unknown`; a partially measured group says so.
Model and tool durations overlap with total stage time and must not be added
to estimate total elapsed time. Diagnostic files contain only enumerated labels,
numeric measurements, opaque run/episode ids and outcomes. Keep them local.
Provider response latency measures request-to-response-headers; it excludes
stream consumption and token generation after headers. Full stage wall time
includes that remaining wait. Stage timing closes on a successful cross-stage
handoff; an active stage is marked interrupted if the session shuts down.
Provider response latency measures request-to-response-headers; it excludes
stream consumption and token generation after headers. Full stage wall time
includes that remaining wait.

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

For live before/after comparisons, copy each pinned task into an isolated
disposable repository at the baseline and candidate revisions. Keep model ids,
provider, thinking levels, routing/feature config, artifacts, and operator
decisions constant. Record the revision/config hashes and one warmup followed by
at least 20 sequential runs per scenario. Keep network/provider waits and
environment details with the report. Live cost or token use is available only
when the model or Jev response returns it; never infer it from duration. The
resume case must use the saved checkpoint/hand-off input, and escalation must
use an eligible stage with the same explicit routing config.
