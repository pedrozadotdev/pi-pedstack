# pi-pedstack

**Turn your AI coding agent into a reliable engineer.**

pi-pedstack is a Pi-native engineering workflow layer: it adds stage discipline, durable artifacts, TDD gates, checkpoints, review, and learning loops on top of your coding agent.

Install, describe what you want to build, then keep saying "continue." pi-pedstack drives the full loop:

 **think → plan → build → review → compound learnings.**

```bash
pi install git:github.com/pedrozadotdev/pi-pedstack
```

---

## Highlights

- **REST-like pipeline loop** — brainstorm → plan → work → review → learn → docsync, with automatic skill routing. Enter debug on demand via `/ped-debug`.
- **Checkpoint resume** — interrupted? Resume from the exact unit you left off
- **TDD enforcement** — every unit follows RED → GREEN → REFACTOR with hard gates
- **Evidence-first review** — auto-assigned reviewers across five axes, autofix loop
- **Knowledge compounding** — solved problems become searchable solution artifacts
- **Persistent task tracking** — checklist tools (`checklist_add`/`checklist_show`/`checklist_del`) prevent dropped tasks and unsafe stage handoffs
- **🐴 Ponytail Discipline** — YAGNI-first code philosophy dynamically injected into plan, work, review, and debug stages: resist unrequested abstractions, prefer stdlib, write the minimum code that works
- **Token-efficient** — ~3,490 tokens new-conversation overhead; progressive loading

---

## Quickstart

```bash
pi install git:github.com/pedrozadotdev/pi-pedstack
```

Then in Pi:

```
You: I want to build a CLI tool that helps indie devs find early users

→ 01-brainstorm: structured discovery → requirements artifact
→ 02-plan: TDD-gated implementation units → plan artifact
→ 03-work: inline execution, checkpoint resume
→ 04-review: five-axis findings, autofix loop
→ 05-learn: knowledge compounding
→ 06-docsync: synchronize documentation

**On-demand:** `/ped-debug` enters the debug stage when bugs are found during review

You: continue
→ Auto-resolves next stage via /ped-next
```

**Resume after interruption:**

```
You: /ped-next
→ Auto-resolves the next stage, applies model/thinking config, resumes from latest checkpoint
```

**Restart current stage clean:**

```
You: /ped-reload
→ Refreshes the current stage with a clean context, re-applies the stage's skill config
```

Skill invocation, reload, and model/thinking level switching are handled automatically by `/ped-start`, `/ped-next`, and `/ped-reload`.

---

## The REST-like Pipeline Loop

```
01-brainstorm → 02-plan → 03-work → 04-review → 05-learn → 06-docsync
    think         plan      build      review       learn      docsync
```

> **On-demand:** Enter `04-5-debug` (debug stage) via `/ped-debug` when bugs are found during review.

| Skill | What it does | Core tool |
|-------|-------------|-----------|
| **01-brainstorm** | Structured multi-round discovery, domain vocabulary persistence | `brainstorm_dialog`, `artifact_helper` |
| **02-plan** | TDD-gated implementation units, mandatory Strict Review before `multi_reviewer` | `plan_diff`, `context_handoff`, `artifact_helper`, `multi_reviewer` |
| **03-work** | Execution with checkpoint resume, strict TDD | `session_checkpoint`, `task_splitter`, `context_handoff` |
| **04-review** | Auto-assigned reviewers, five-axis findings, autofix loop | `review_router`, `multi_reviewer`, `context_handoff` |
| **04-5-debug** *(on-demand)* | Debug and fix issues with a 5-phase workflow: Information Gathering, Root Cause Analysis, Implementation, Verification, Report. Enter via `/ped-debug`. | `context_handoff` |
| **05-learn** | Pattern extraction → searchable solution artifacts | `pattern_extractor`, `context_handoff`, `artifact_helper` |
| **06-docsync** | Synchronize project documentation after completion | `context_handoff` |

### Model & Thinking Routing

You can customize the model and thinking level used for each workflow stage by editing the configuration file.

The configuration is loaded with the following priority:

1. **Project-level**: `.pi/pi-pedstack/config.json`
2. **Global-level**: `~/.pi/pi-pedstack/config.json`

Model and thinking level switching is handled automatically by the ce-core extension when you invoke a pipeline stage via `/ped-start <prompt>` or `/ped-next [prompt]`. Each command reads the per-stage config and switches the active model and thinking level before invoking the skill.

All pipeline skills declare `disable-model-invocation: true` in their frontmatter to ensure they can only be invoked by the user via explicit commands, strictly guaranteeing that model routing rules are enforced.

Here is a complete configuration schema example:

```json
{
  "brainstorm": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "plan": {
    "model": "anthropic/claude-opus-4-20250115",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "work": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  },
  "review": {
    "model": "anthropic/claude-opus-4-20250115",
    "thinkingLevel": "high",
    "reviewers": [
      { "model": "anthropic/claude-sonnet-4-20250514", "thinkingLevel": "high" }
    ]
  },
  "debug": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  },
  "learn": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium",
    "reviewers": [
      { "model": "anthropic/claude-opus-4-20250115", "thinkingLevel": "high" }
    ]
  },
  "docsync": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "thinkingLevel": "medium"
  }
}
```

#### Supported Keys and Options

- **`reviewers`**: Stages that support parallel reviews (`brainstorm`, `plan`, `review`, `learn`) can define an array of sub-reviewers. These reviews will run concurrently using subagents on the specified models.

### Dynamic Append Instructions

For each stage, you can inject custom project-specific instructions by creating markdown files in the `.agents/appends/` directory at your project root.

The system loads two sources per stage, merged into the system prompt:

**Global (all stages):** `.agents/appends/ALL.md` — if present, injected into every stage.

**Per-stage:** Uppercase file names matching the active step name:

- `.agents/appends/BRAINSTORM.md`
- `.agents/appends/PLAN.md`
- `.agents/appends/WORK.md`
- `.agents/appends/REVIEW.md`
- `.agents/appends/DEBUG.md`
- `.agents/appends/LEARN.md`
- `.agents/appends/DOCSYNC.md`

If both `ALL.md` and a per-stage file exist, their contents are combined (global first, then stage-specific). If present, these files are loaded and appended directly to the active prompt context, helping customize guidelines for specific steps.

## Design Philosophy & Acknowledgements

**80% planning and review, 20% execution.**

The goal is not to make AI write code faster. The goal is to make AI think before writing, review after writing, and compound what it learns.

pi-pedstack is not a fork or wrapper. It extracts useful methods from the projects below and rebuilds them with Pi-native skills, tools, artifacts, checkpoints, and handoffs.

| Project | What pi-pedstack adopted |
|---------|------------------------|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | "Use when" skill trigger conditions, source-driven verification, stop-the-line hard gate, anti-rationalization, and the five-axis review baseline. Adopted as embedded micro-patterns only — no new skills, tools, commands, or agents. |
| [everything-claude-code](https://github.com/affaan-m/everything-claude-code) | Checkpoint resume, continuous learning loops, and token-conscious agent workflow design. |
| [humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents) | Context window ownership, compacting resolved errors, retry caps, and pre-fetching obvious prerequisites. Adopted as lightweight context hygiene rules inside the existing Phase 1 pipeline. |
| [superpowers](https://github.com/obra/superpowers) | Strict TDD gates, design checklists, review discipline, and the idea that agents need hard gates instead of gentle suggestions. |
| [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | The five-step think → plan → build → review → learn loop and the knowledge-compounding backbone. |
| [gstack](https://github.com/garrytan/gstack) | YC-style forcing questions, CEO Review cognitive frameworks, browser QA patterns, failure maps, and evidence-first validation. |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Context glossary (`CONTEXT.md`) for cross-session term persistence, lightweight ADR with three-condition threshold, and feedback-loop-first debug discipline. Adopted as reference templates embedded into existing skills — no new skills or tools. |

---

## Behavioral Gates

### Stop-the-line (Hard gate)

When an unexpected failure occurs during `03-work`:

1. **STOP** adding features
2. **PRESERVE** evidence
3. **DIAGNOSE** root cause — build a feedback loop first, then reproduce → hypothesise → instrument → fix
4. **FIX** the root cause, not the symptom
5. **GUARD** with a regression test
6. **RESUME** only after verification passes

Anti-rationalization: do not rationalize, downgrade, or explain away failures. Stop and report with evidence.

### Source-driven verification

When implementation depends on a framework/library API, version-specific behavior, or a recommended pattern: verify against official documentation using the `contextqmd` CLI as the primary tool (see [shared contextqmd docs instruction](skills/references/contextqmd-docs.md)) before implementing. Pure logic, renaming, or in-project pattern reuse does not require external citation.

### Review five axes

All reviewers evaluate changes across: **correctness, readability, architecture, security, performance.**

---

## 🐴 Ponytail Discipline (YAGNI / Lazy Senior Dev Mode)

The Ponytail strategy keeps the codebase lean by forcing every implementation choice through a 6-rung ladder before any code is written. It is dynamically injected into the system prompt during `02-plan`, `03-work`, `04-review`, and `04-5-debug` stages.

### The 6 Rungs (in order)

| # | Question | Action |
|---|----------|--------|
| 1 | Does this need to be built at all? | YAGNI — delete the requirement if possible |
| 2 | Does the standard library already do this? | Use it |
| 3 | Does a native platform feature cover it? | Use it |
| 4 | Does an already-installed dependency solve it? | Use it |
| 5 | Can this be one line? | Make it one line |
| 6 | Only now | Write the minimum code that works |

### Rules

- **No unrequested abstractions** — interfaces, factories, or base classes that weren't explicitly in the requirements are noise. Delete them.
- **No new dependencies if avoidable** — prefer `node:fs` over `fs-extra`, `fetch` over `axios`, built-in test runner over Jest.
- **Deletion over addition** — when in doubt, remove lines. Every line that ships is a line that must be maintained.
- **Boring over clever** — simple loops beat functional pipelines, switch statements beat reflection, plain objects beat metaprogramming.
- **Mark with `ponytail:` comments** — annotate intentional simplifications so reviewers know the shortcut was deliberate.
- **Do NOT compromise on security, input validation, or error handling** — Ponytail is about code volume, not correctness.

### Handoff blockers

Only add a blocker in `context_handoff save` when an actual problem blocks progress. An empty/absent `blocker` field lets `/ped-next` advance the pipeline. Placeholder blockers like "N/A" or "No blockers" are stripped automatically.

---

## Token Cost

New conversation overhead: **~3,490 tokens** (1.7% of 200K context).

| Component | Tokens |
|-----------|--------|
| 7 pipeline skill registrations | ~850 |
| 24 tool schemas (14 CE + 10 built-in) | ~2,640 |
| Skill context (per user invocation) | ~300–1,200 |

Progressive loading: only needed skills loaded on-demand.

---

## Generated Structure

```
your-project/
├── docs/
│   ├── brainstorms/      # Requirements
│   ├── plans/             # Execution plans
│   ├── reviews/           # Review findings reports
│   ├── adr/               # Architecture decisions (lazy)
│   └── solutions/         # Knowledge cards
├── prompts/              # Workflow prompt templates (ped-commit, ped-create-issue, ped-open-pr)
└── .context/
    └── compound-engineering/
        ├── checkpoints/   # Breakpoint files
        ├── handoffs/      # Cross-stage context
        ├── history/       # Execution history
        └── checklist.json # Persistent task list
```

Commit everything to git — these files are the project's traceable memory.

---

## Architecture

| Component | Count |
|-----------|------:|
| Skills | 7 |
| Tools | 14 CE + 10 Pi built-in |
| Rules | 79 |
| TypeScript lines | ~14,025 |
| Tests | 359 (1,178 assertions) |

Rules in `rules/` cover 11 common topics + language-specific sets (TypeScript, Rust, Go, Python, Java, Kotlin, C++, C#, Dart, Swift, Perl, PHP). Project-level overrides take priority.

---

## Commands

| Command | Description |
|---------|-------------|
| `bun test` | Run all tests |
| `/ped-start <prompt>` | Start a new Pedstack workflow with a user prompt, launching 01-brainstorm |
| `/ped-next [prompt]` | Auto-resolve and advance to the next pipeline stage |
| `/ped-reload` | Restart the current pipeline stage from a fresh context, re-applying skill config |
| `/ped-fix-issues <#1,#2,...>` | Prompt-inject GitHub issue context into 01-brainstorm |
| `/ped-debug <prompt>` | Enter 04-5-debug on demand with gating (warns if before 04-review). Prompt is required. |

Auto-advance: `/ped-next` is automatically queued after every successful handoff save, except for two gated transitions (`02-plan→03-work` and `04-review→05-learn`) which prompt for confirmation. The authorization persists per-session.

---

## Links

- **GitHub**: <https://github.com/pedrozadotdev/pi-pedstack>
- **License**: MIT

---

## Credits

This project is based on the [super-pi tools](https://github.com/leing2021/super-pi/tree/main/extensions/ce-core/tools) project.
