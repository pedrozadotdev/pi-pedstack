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

- **REST-like pipeline loop** — brainstorm → plan → work → review → debug → learn → docsync, with automatic skill routing
- **Checkpoint resume** — interrupted? Resume from the exact unit you left off
- **TDD enforcement** — every unit follows RED → GREEN → REFACTOR with hard gates
- **Evidence-first review** — auto-assigned reviewers across five axes, autofix loop
- **Knowledge compounding** — solved problems become searchable solution artifacts
- **Token-efficient** — ~3,160 tokens new-conversation overhead; progressive loading

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
→ 04-5-debug: routing based on user testing
→ 05-learn: knowledge compounding
→ 06-docsync: synchronize documentation

You: continue
→ Next skill recommended via /skill:00-next
```

**Resume after interruption:**

```
You: /skill:03-work docs/plans/plan.md
→ Loads checkpoint, skips completed units, resumes from breakpoint
```

---

## The REST-like Pipeline Loop

```
01-brainstorm → 02-plan → 03-work → 04-review → 04-5-debug → 05-learn → 06-docsync
    think         plan      build      review       debug       learn      docsync
```

| Skill | What it does | Core tool |
|-------|-------------|-----------|
| **01-brainstorm** | Structured multi-round discovery, domain vocabulary persistence | `brainstorm_dialog`, `artifact_helper` |
| **02-plan** | TDD-gated implementation units, optional CEO Review | `plan_diff`, `context_handoff`, `artifact_helper` |
| **03-work** | Execution with checkpoint resume, strict TDD, subagent delegation | `session_checkpoint`, `task_splitter`, `context_handoff` |
| **04-review** | Auto-assigned reviewers, five-axis findings, autofix loop | `review_router`, `multi_reviewer`, `context_handoff` |
| **04-5-debug** | Routing based on user testing (return to work or continue to learn) | `context_handoff` |
| **05-learn** | Pattern extraction → searchable solution artifacts | `pattern_extractor`, `context_handoff`, `artifact_helper` |
| **06-docsync** | Synchronize project documentation after completion | `context_handoff` |
| **00-next** | Next-step recommendation + workflow status | `workflow_state`, `session_history` |

### Model & Thinking Routing

You can customize the model and thinking level used for each workflow stage by editing the configuration file.

The configuration is loaded with the following priority:
1. **Project-level**: `.pi/pi-pedstack/config.json`
2. **Global-level**: `~/.pi/pi-pedstack/config.json`

Each stage switches the active model and thinking level automatically when you invoke it via `/skill:0X-stageName`. All pipeline skills declare `disable-model-invocation: true` in their frontmatter to ensure they can only be invoked by the user, thereby strictly guaranteeing that model routing rules are enforced.

Here is a complete configuration schema example:

```json
{
  "imageDescriptor": {
    "model": "google/gemini-2.5-flash",
    "thinkingLevel": "off"
  },
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

* **`imageDescriptor`**: Customizes the vision model used to describe user-attached images (defaulting to `google/gemini-2.5-flash`).
* **`reviewers`**: Stages that support parallel reviews (`brainstorm`, `plan`, `review`, `learn`) can define an array of sub-reviewers. These reviews will run concurrently using subagents on the specified models.

### Dynamic Append Instructions

For each stage, you can inject custom project-specific instructions by creating markdown files in the `.pi/pi-pedstack/appends/` directory.

The system will search for uppercase file names matching the active step name:
- `.pi/pi-pedstack/appends/BRAINSTORM.md`
- `.pi/pi-pedstack/appends/PLAN.md`
- `.pi/pi-pedstack/appends/WORK.md`
- `.pi/pi-pedstack/appends/REVIEW.md`
- `.pi/pi-pedstack/appends/DEBUG.md`
- `.pi/pi-pedstack/appends/LEARN.md`
- `.pi/pi-pedstack/appends/DOCSYNC.md`

If present, these files are loaded and appended directly to the active prompt context, helping customize guidelines for specific steps.

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

## Token Cost

New conversation overhead: **~3,160 tokens** (1.6% of 200K context).

| Component | Tokens |
|-----------|--------|
| 8 pipeline skill registrations | ~850 |
| 21 tool schemas (11 CE + 10 built-in) | ~2,310 |
| Skill context (per user invocation) | ~300–1,200 |

Progressive loading: only needed skills loaded on-demand.

---

## Generated Structure

```
your-project/
├── docs/
│   ├── brainstorms/      # Requirements
│   ├── plans/             # Execution plans
│   ├── adr/               # Architecture decisions (lazy)
│   └── solutions/         # Knowledge cards
└── .context/
    └── compound-engineering/
        ├── checkpoints/   # Breakpoint files
        ├── handoffs/      # Cross-stage context
        └── history/       # Execution history
```

Commit everything to git — these files are the project's traceable memory.

---

## Architecture

| Component | Count |
|-----------|------:|
| Skills | 8 |
| Tools | 11 CE + 10 Pi built-in |
| Rules | 78 |
| TypeScript lines | ~4,100 |
| Tests | 170 (688 assertions) |

Rules in `rules/` cover 11 common topics + language-specific sets (TypeScript, Rust, Go, Python, Java, Kotlin, C++, C#, Dart, Swift, Perl, PHP). Project-level overrides take priority.

---

## Commands

| Command | Description |
|---------|-------------|
| `bun test` | Run all tests |

---

## Links

- **GitHub**: https://github.com/pedrozadotdev/pi-pedstack
- **License**: MIT

---

## Credits

This project is based on the [super-pi tools](https://github.com/leing2021/super-pi/tree/main/extensions/ce-core/tools) project.
