# pi-pedstack

A Pi-native coding workflow with structured brainstorming, planning, implementation, review, learning, and documentation. Stage gates, checkpointing, optional semantic tooling, and model routing help keep work on track.

## Install and use

```bash
pi install git:github.com/pedrozadotdev/pi-pedstack
```

Inside Pi:

```text
/ped-start Build a CLI tool to analyze logs
/ped-next
/ped-reload
/ped-debug
/ped-fix-issues
```

| Command | Purpose |
| --- | --- |
| `/ped-start <request>` | Start a new workflow from 01-brainstorm |
| `/ped-next [prompt]` | Continue from the saved handoff |
| `/ped-reload` | Restart the active stage with refreshed context and model settings |
| `/ped-debug` | Enter on-demand 04-5-debug |
| `/ped-fix-issues` | Start an issue-fixing workflow |

The normal path is `01-brainstorm → 02-plan → 03-work → 04-review → 05-learn → 06-docsync`. If `04-review` finds unresolved issues, it routes back to `03-work` for fixes and then re-reviews before learning. `04-5-debug` is on demand. Handoffs and checkpoints let you resume after interruptions.

## Configure

Pedstack reads one JSON configuration file:

1. Project: `.pi/pi-pedstack/config.json` (preferred)
2. Global: `~/.pi/pi-pedstack/config.json` (used only when no project file exists)

The project file **replaces**, rather than merges with, the global file. Invalid configuration is rejected; there are no environment-variable overrides for the feature policies below. Restart Pi after changing startup feature settings.

The only required block in a configuration file is `models`. The entire `routing` block, as well as all stage-specific and feature blocks, is optional. Omitting `routing` enables model selection immediately with the defaults below (`shadow: false`).

### Model roles and thinking

```json
{
  "models": {
    "default": { "model": "provider/cheap-model", "thinkingLevel": "medium" },
    "review": { "model": "provider/review-model", "thinkingLevel": "high" },
    "sota": { "model": "provider/strong-model", "thinkingLevel": "max" }
  }
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `models.default` | Unset | Normal work model; choose a cheaper model for regular stages |
| `models.review` | Unset | Reviewer used in a separate invocation when independent review is requested; may use the same model ID as SOTA |
| `models.sota` | Unset | Stronger execution model for qualifying complexity or stage-gate escalation |
| `models.<role>.model` | Unset | Model ID in `provider/model` format |
| `models.<role>.thinkingLevel` | Unset | Thinking effort; see allowed values below |
| `routing.shadow` | `false` | `true`: record routing decisions without applying automatic role switches; `false`: apply the selected role |
| `routing.sotaMinScore` | `0.6` | Minimum Jev complexity score to proactively select SOTA |
| `routing.sotaMinConfidence` | `0.5` | Minimum confidence for proactive SOTA selection |
| `routing.maxEscalationsPerStage` | `1` | Maximum proactive Jev SOTA selections per stage in a workflow; mandatory gate escalations bypass this budget |

Allowed `thinkingLevel` values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; legacy string aliases `"0"`, `"1"`, `"2"` are also accepted. An invalid value is rejected instead of becoming `medium`.

To customize routing, optionally add a `"routing"` object; any omitted fields inherit the defaults above. Set `"routing": { "shadow": true }` only if you want to evaluate decisions without applying model changes.

For an explicit **stage model override** (wins over routing), use any of `brainstorm`, `plan`, `work`, `review`, `debug`, `learn`, `docsync`:

```json
{
  "models": { "default": { "model": "provider/cheap-model" } },
  "plan": {
    "model": "provider/planning-model",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "provider/reviewer-model", "thinkingLevel": "max" }
    ]
  }
}
```

`reviewers` is supported on `brainstorm`, `plan`, `review`, and `learn` only. The other stages accept `model` and optional `thinkingLevel`. Use `models` for normal configuration and stage overrides only when intentional. During enforced routing (`routing.shadow: false`), a gate escalation automatically restarts the same stage under SOTA after the turn finishes. `/ped-reload` remains a manual fallback if automatic re-entry cannot start. The review model is not the normal execution model.

### Guarded Gemini reviewers (Antigravity CLI)

Selected Gemini reviewers run through Antigravity CLI (`agy`); other reviewers continue through Pi. Explicit stage `reviewers[]` entries take precedence over the `models.review` fallback, and the configured model ID is passed exactly as supplied. Reviewers run in a fresh no-session process, so they may reuse an execution model ID without reviewing the same session.

Configure an exact ID listed by `agy models`:

```json
{
  "models": {
    "review": {
      "model": "gemini-<exact-id-from-agy-models>",
      "thinkingLevel": "high"
    }
  }
}
```

Unavailable model IDs or unsupported thinking levels abort the review; there is no alias, default-model, or Pi fallback. Install the bundled reviewer plugin explicitly from the package or checkout:

```bash
agy plugin validate ./plugins/agy-reviewer
agy plugin install ./plugins/agy-reviewer
```

The plugin and agent are named `pi-pedstack-reviewer`. Guarded reviews currently support Linux, agy 1.3.1, Bun, Node, CommandCode's `cmd`, and `/usr/bin/git` 2.47.3. Preflight verifies plugin activation and runs a disposable hook challenge before repository access. Unsupported hooks/customizations, missing prerequisites, guard failures, and incomplete reviews abort without a success sidecar. The reviewer can perform bounded repository reads and safe Git status inspection only; writes, arbitrary commands, tests/builds, network/MCP access, and nested agents are denied.

The opt-in native agy end-to-end test and Windows-host validation were not run; Windows is unsupported for guarded Gemini reviews.

### Feature modes

Each mode accepts `"off" | "shadow" | "enforce"`. All eight feature modes default to **`enforce`**. `shadow` evaluates/logs semantic judgments without enforcing them; `off` disables the feature. Deterministic hard guards may remain active even where semantic mode is shadow.

Example: change only the features you want to customize.

```json
{
  "models": { "default": { "model": "provider/cheap-model" } },
  "features": {
    "stageGate": { "mode": "enforce" },
    "overengineering": { "mode": "enforce" },
    "handoffReadiness": { "mode": "enforce", "failClosed": false },
    "docsVerification": { "mode": "enforce", "failClosed": false },
    "driftGuard": { "mode": "enforce", "failClosed": false },
    "compactionGuard": { "mode": "enforce", "live": false },
    "injectionScreen": { "mode": "enforce" },
    "stageGuard": { "mode": "enforce", "failClosed": false, "disabled": false }
  }
}
```

| Feature | Example of what it does | Additional options (default) |
| --- | --- | --- |
| `features.stageGate` | Checks each stage's completion artifact before a handoff; may request revision, review, or escalation | `mode: "enforce"` |
| `features.overengineering` | Flags unnecessary abstractions/dependencies during stage evaluation (YAGNI) | `mode: "enforce"` |
| `features.handoffReadiness` | Assesses whether a handoff has enough information for the next stage | `failClosed: false`: semantic evaluation failure doesn't independently block |
| `features.docsVerification` | Triggers source-backed documentation verification when appropriate | `failClosed: false` |
| `features.driftGuard` | Detects turns that drift outside the active stage's responsibilities | `failClosed: false` |
| `features.compactionGuard` | Monitors context pressure and recommends compacting or handing off | `live: false`: live semantic calibration disabled |
| `features.injectionScreen` | Flags potentially hostile text from external tool results | `mode: "enforce"` |
| `features.stageGuard` | Blocks forbidden stage operations (such as editing implementation during planning) | `failClosed: false`; `disabled: false` (set `true` to bypass this guard) |

`failClosed: true` opts into blocking when that semantic subsystem is unavailable in applicable enforced modes. The stage guard's deterministic restrictions are separate from its semantic evaluation. For detailed enforcement/edge-case behavior, see [Architecture and development](docs/ARCHITECTURE.md).

### Semantic solution ranking

`solution_search` and stage context loading can rank reusable cards in `docs/solutions/`.

```json
{
  "models": { "default": { "model": "provider/cheap-model" } },
  "solutionRanking": {
    "shadow": false,
    "minRank": 0.6,
    "minConfidence": 0.5,
    "concurrency": 4,
    "candidates": 15,
    "limit": 3
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `solutionRanking.shadow` | `true` | Log ranking while retaining non-enforced behavior; set `false` to enforce Jev ranking |
| `minRank` | `0.6` | Minimum relevance score |
| `minConfidence` | `0.5` | Minimum scoring confidence |
| `concurrency` | `4` | Concurrent candidate judgments |
| `candidates` | `15` | Candidates considered per ranking pass |
| `limit` | `3` | Maximum ranked results |

### Semantic reads and file scouting

`semantic_read` and `semantic_scout` help choose which files to open using compact, typed descriptions rather than dumping file contents.

```json
{
  "models": { "default": { "model": "provider/cheap-model" } },
  "semanticRead": {
    "excerptBytes": 4096,
    "maxPaths": 24,
    "concurrency": 4,
    "selectLimit": 12,
    "deadlineMs": 45000,
    "select": true
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `excerptBytes` | `4096` | Maximum excerpt bytes examined per path |
| `maxPaths` | `24` | Maximum paths considered |
| `concurrency` | `4` | Parallel semantic requests |
| `selectLimit` | `12` | Maximum selected paths |
| `deadlineMs` | `45000` | Time budget in milliseconds |
| `select` | `true` | Enable semantic selection of relevant paths |

## Common examples

**Use cheap execution with strong review:** set `models.default` to your lower-cost worker, `models.review` to a stronger reviewer, and `models.sota` to your escalation model. Routing applies automatically; no `routing` block is required.

**Reduce semantic activity for debugging:** set individual `features.<name>.mode` to `"shadow"` to observe results without semantic enforcement, or `"off"` to disable that subsystem. Keep stage hard guards enabled unless you deliberately need a bypass.

**Conserve cost in solution search:** leave `solutionRanking.shadow: true` until rankings have been evaluated, or use `limit` and `candidates` to control how many results are considered.

**Recover from an interrupted task:** run `/ped-next`. To restart the active stage with its latest model routing, run `/ped-reload`.

## More information

- [Local cost and latency diagnostics](docs/benchmarks/issue-62/README.md) — opt-in run capture, compact reports and pinned regression baselines
- [Architecture and development reference](docs/ARCHITECTURE.md) — detailed architecture, gates, stage contracts, internals, debugging and development
- [Pipeline instructions](skills/references/pipeline-config.md) — skill execution and handoff rules
- [GitHub issues](https://github.com/pedrozadotdev/pi-pedstack/issues) — bugs and requests
