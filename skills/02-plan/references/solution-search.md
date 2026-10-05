# Solution Search Strategy

Use the `solution_search` engine to find relevant solutions before planning or reviewing. Do **not** hand-rank candidates with grep — deterministic recall and semantic ranking happen in TypeScript.

## Steps

1. **Summarize the task** in a few sentences: technical terms, error symptoms, component types.
2. **Call the tool:**
   ```text
   solution_search({ query: "<task summary>", repoRoot: "<project root>" })
   ```
3. **Read only what the tool returns** — at most 3 fully-read cards.
4. **Honor the returned `status`:**
   - `ok` — 1–3 cards crossed the relevance bar; apply their guidance.
   - `none` — nothing crossed the bar. This is valuable information: the area has no prior learnings, so proceed normally.
   - `degraded` — semantic ranking was unavailable; the cards are deterministically `prior`-ranked. Treat them as candidates, not verified matches.

## Search locations

- **Project-level**: `{project-root}/docs/solutions/` — project-specific solutions

The engine scans `docs/solutions/**` recursively (frontmatter first, bounded body fallback) and matches on `tags`, `title`, `category`, and `applies_when`.

## Output

- The tool's `status` and result list (path, title, category, severity, tags, rank, confidence, source)
- Key takeaways from the returned solutions
- How they apply to the current task

## When to use

- `02-plan`: Before creating implementation units, check for existing patterns
- `04-review`: Before reviewing, check for known failure modes or solutions
