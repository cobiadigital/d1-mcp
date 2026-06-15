# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Cloudflare Worker that implements an MCP (Model Context Protocol) server over JSON-RPC 2.0, giving AI clients SQL access to a Cloudflare D1 database. The entire server lives in `src/index.ts` (single file, ~300 lines).

## Commands

```bash
npm run dev          # Local dev server via Wrangler
npm run deploy       # Deploy to Cloudflare Workers
npm run type-check   # TypeScript type check (no emit)
```

There are no tests. Type checking is the only automated verification.

## Architecture

### Request Flow

All requests hit the Cloudflare Worker's `fetch` handler → `/mcp` endpoint → `handleMessage()` → `callTool()` → Cloudflare D1.

- `/health` — simple health check
- `/mcp` — JSON-RPC 2.0 endpoint; supports single requests, batch arrays, and SSE (`Accept: text/event-stream`)
- CORS is handled via preflight OPTIONS responses
- Auth is optional: set `MCP_AUTH_TOKEN` env var to require `Authorization: Bearer <token>`

### MCP Tools Exposed

Four tools defined in the `TOOLS` constant array:
1. **`list_tables`** — queries `sqlite_master` for all tables
2. **`describe_table`** — returns schema/column info for a named table
3. **`execute_sql`** — runs arbitrary SQL with optional `params` array for parameterized queries
4. **`add_media_item`** — inserts a book, movie, or TV show into `media_items`, auto-fetching a cover image via the iTunes Search API

### `add_media_item` — Image Lookup

Uses the **iTunes Search API** (free, no API key needed) to find cover art:
- `book` → `entity=ebook`
- `movie` → `entity=movie`
- `tv` → `entity=tvSeries`

The API returns `artworkUrl100`; the tool rewrites the size token to `600x600bb` for a higher-resolution image. Image lookup failure is non-fatal — the item is inserted with `image_url = NULL`.

The `media_items` table is created automatically on first use:
```sql
CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('book', 'movie', 'tv')),
  image_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

### D1 Query Execution (`callTool`)

- Uses `env.DB.batch()` for all queries
- `isReadOnly()` determines routing: read queries use `.all()`, write queries use `.run()`
- `isValidIdentifier()` guards table name inputs used in PRAGMA statements (prevents SQL injection via identifier interpolation — parameterized queries handle value injection)
- Tool errors are returned as JSON-RPC results with `isError: true`, not as JSON-RPC errors

### Environment Bindings (`wrangler.toml`)

- `DB` — D1 database binding (`d1-mcp-db`, ID `1b58d81c-0321-4759-a79c-2ac2e19114df`)
- `MCP_AUTH_TOKEN` — optional secret for Bearer auth (set via `wrangler secret put MCP_AUTH_TOKEN`)

### TypeScript Config

Strict mode, ES2022 target, `moduleResolution: "bundler"`, Cloudflare Workers types. No emit — Wrangler handles bundling from source directly.

## Media Workflow

### Adding a Specific Item

When asked to add a specific book, movie, or TV show:

1. **Check for duplicates** — query the DB (`SELECT title, media_type FROM media_items`) before inserting
2. **Fetch a cover image**:
   - Movies/TV: TMDB at `w500` size
   - Books: Open Library by ISBN-L; if the response is a placeholder (43 bytes), find an alternate source
3. **Write a description** — max 300 chars; no character names, actor names, director names, or place names
4. **INSERT via `execute_sql`** directly against the MCP endpoint — do NOT use the `add_media_item` tool (wrong schema)

### Offering Suggestions

When asked to suggest items:

1. **Query the full DB** to see everything already in it (avoid repeats)
2. **Analyze ratings** — high-rated items reveal taste; low-rated items signal what to avoid; weight suggestions accordingly
3. **Propose 8–10 items** across types with a brief rationale for why each fits the taste profile
4. **On confirmation**, run the add steps above for the whole batch in parallel where possible

### Key Rules

- Descriptions: max 300 chars, no character names, actor names, director names, or place names
- Cover images: TMDB `w500` for movies/TV; Open Library ISBN-L for books; verify Open Library images are not placeholders (43 bytes = placeholder, find alternate)
- All DB writes go through `execute_sql` directly — the built-in `add_media_item` tool uses the wrong schema
