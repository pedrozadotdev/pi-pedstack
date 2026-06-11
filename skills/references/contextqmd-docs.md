# ContextQMD Documentation Lookup

Use the `contextqmd` CLI to install, search, and read library documentation locally. All search is local after a one-time install — no network during search. Always pass `--json` for structured, parseable output.

## When to Use

**`contextqmd` CLI is the primary documentation tool.** Use it to:
- Verify framework/library-specific APIs, patterns, and version-specific behavior before planning or implementing.
- Perform local-first searches with version pinning and semantic/hybrid search capability.

## Workflow

### 1. Check what's already installed

```bash
contextqmd libraries list --json
```

If the library and version you need is already listed, skip to step 3.

### 2. Find and install

Search the registry:

```bash
contextqmd libraries search "react" --json
contextqmd libraries search "laravel" --limit 10 --json
```

Install one or many libraries at once:

```bash
contextqmd libraries install react
contextqmd libraries install react laravel kamal
contextqmd libraries install react@19.2.0
```

The `@version` syntax pins a specific version. Installation downloads a docs bundle (SHA-256 verified), falls back to page-by-page API if needed, and indexes everything for local search. Idempotent — re-running when docs are current is a no-op.

### 3. Search locally

```bash
contextqmd docs search "authentication guards" --library laravel --json
contextqmd docs search "useRef" --library react@19.2.0 --json
contextqmd docs search "middleware" --library laravel --mode fts --max-results 10 --json
```

Search is entirely local. If the library isn't installed, you'll get a `NOT_INSTALLED` error — go back to step 2.

**JSON output fields per result:** `doc_path`, `page_uid`, `title`, `score`, `snippet`, `line_start`, `line_end`, `search_mode`, `url`

### 4. Read a specific page

Use `--doc-path` (canonical path from search results) or `--page-uid` (UID fallback):

```bash
contextqmd docs get --library laravel --doc-path authentication.md --json
contextqmd docs get --library react@19.2.0 --page-uid hooks/useRef --json
```
