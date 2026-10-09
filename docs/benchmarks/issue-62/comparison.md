# Offline regression comparison

Baseline: `f39d6845d309e540a8198215668f31ead0d13d0e` on Bun 1.4.2 / Pi 0.80.10.
Candidate: same base revision plus the current uncommitted source tree, fingerprint `095329244821b0d8a4056d2d90bea889abc4e3350fc8f92023be339eb335db1f`.
Both use one warmup, 20 sequential samples, nearest-rank p95 and sample variance. These are test-batch timings, not live workflows or provider latency.

| Scenario | Baseline median ms | Candidate median ms | Baseline p95 ms | Candidate p95 ms | Candidate variance ms² |
|---|---:|---:|---:|---:|---:|
| fast | 222.767 | 217.454 | 228.496 | 226.273 | 57.311 |
| standard | 349.309 | 351.096 | 359.056 | 363.371 | 66.875 |
| deep | 534.234 | 541.120 | 545.639 | 562.969 | 105.872 |
| debug | 404.740 | 398.928 | 419.945 | 420.403 | 292.484 |

The scenario batches vary slightly across runs; candidate medians moved by less than 4% in either direction. Live stage wall time, provider model calls/tokens/cost, and actual workflow Jev counts remain unknown because this headless regression pass does not run Pi workflows or live providers. The optional diagnostics report supplies those values in an instrumented local Pi session.
