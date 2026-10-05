# Solution Search Strategy

Tool-based retrieval for `docs/solutions/`. Use this in `02-plan` and `04-review` to find relevant learnings, and in `05-learn` to check a new card for overlap.

## Search locations

- **Project-level**: `{project-root}/docs/solutions/` — project-specific solutions

## Steps

### Step 1: Build the query

From the task/feature description (or the new solution's text in `05-learn`), summarize:
- **Technical terms**: tool names, framework names, language concepts
- **Problem indicators**: error symptoms, failure modes, performance issues
- **Component types**: CLI, extension, skill, test, config

### Step 2: Call `solution_search`

```text
solution_search({ query: "<summary>", repoRoot: "<project root>" })
```

The engine performs deterministic recall (frontmatter `tags`, `title`, `category`, `applies_when`, plus a bounded body fallback) and semantic ranking. Keyword extraction, `severity`, `tags`, and thresholds stay in TypeScript — do not hand-score.

### Step 3: Read `status`

| Status     | Meaning                             | Action                                           |
| ---------- | ----------------------------------- | ------------------------------------------------ |
| `ok`       | 1–3 cards crossed the relevance bar | Read and apply the returned cards                |
| `none`     | Nothing crossed the bar             | Proceed; an empty result is valuable information |
| `degraded` | Semantic ranking unavailable        | Use the `prior`-ranked cards as candidates only  |

### Step 4: `05-learn` overlap check

When writing a new solution, run the same engine in **overlap** mode with the new card's text as the query:

```text
solution_search({ query: "<new solution text>", repoRoot: "<project root>", mode: "overlap" })
```

Overlap questions are `duplicate`, `overlap`, and `conflict`. `conflict` is surfaced separately as a warning — never fold it into the score. If a card duplicates an existing solution, update the existing card instead of adding a new one.

## When to stop

If `status` is `none`, do **not** fall back to reading all files. Report "No relevant solutions found" and proceed. An empty result means the area has no prior learnings.
