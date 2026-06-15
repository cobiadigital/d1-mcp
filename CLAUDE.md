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
4. **`add_media_item`** — ⚠️ **do not use.** Inserts into a `media_items` shape that does not match the live DB (see [Database Schema](#database-schema)). Use `execute_sql` instead.

### `add_media_item` — Image Lookup

Uses the **iTunes Search API** (free, no API key needed) to find cover art:
- `book` → `entity=ebook`
- `movie` → `entity=movie`
- `tv` → `entity=tvSeries`
- `album` → `entity=album`
- `single` → `entity=musicTrack`

The API returns `artworkUrl100`; the tool rewrites the size token to `600x600bb` for a higher-resolution image. Image lookup failure is non-fatal.

> **⚠️ Do NOT use the `add_media_item` tool to add anything.** It writes to a
> table shape that does **not** match the live database (it uses
> `media_type` / `image_url` / `notes` and creates its own `CREATE TABLE IF
> NOT EXISTS media_items` with those columns). The real `media_items` table
> uses `type` / `cover_image_url` / `description` plus `author_creator`,
> `genre`, `release_year`, etc. — see [Database Schema](#database-schema)
> below. All adds must go through `execute_sql` with the real schema.

## Database Schema

This is the **actual** schema in the live D1 (`d1-mcp-db`). Always write to
these tables/columns — verify with `describe_table` if unsure. The
`add_media_item` tool's self-created table is wrong; ignore it.

### `media_items` — the catalog (books, movies, TV, music)

```sql
CREATE TABLE media_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL CHECK(type IN ('book','tv_show','movie','album','single')),
  title           TEXT NOT NULL,   -- title ONLY (e.g. "Sky Blue Sky"), not "Artist Title"
  author_creator  TEXT,            -- artist / author / director — the creator
  genre           TEXT,
  release_year    INTEGER,
  description     TEXT,            -- max 300 chars, no proper names (see Key Rules)
  cover_image_url TEXT,
  external_id     TEXT,            -- e.g. iTunes/MusicBrainz id
  metadata        TEXT,            -- optional JSON blob
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Note: `type` values are `book`, `tv_show`, `movie`, `album`, `single`
(TV is `tv_show`, **not** `tv`).

Correct insert for an album:
```sql
INSERT INTO media_items (type, title, author_creator, genre, release_year, description, cover_image_url)
VALUES ('album', ?, ?, ?, ?, ?, ?);
-- params: title, artist, genre, year, description, cover_url
```

### `ratings` — 1–10 score + optional review (unique per user+item)

```sql
CREATE TABLE ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  rating   INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 10),
  review   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, media_id)
)
```

### `tags` + `media_tags` — many-to-many tagging

```sql
CREATE TABLE tags ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL );
CREATE TABLE media_tags (
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);
```

### `users`

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Other tables present: `watchlist`, `user_preferences`, `_cf_KV`,
`sqlite_sequence` (run `list_tables` / `describe_table` to inspect).

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

When asked to add a specific book, movie, TV show, album, or single:

1. **Check for duplicates** — query the DB (`SELECT title, type, author_creator FROM media_items`) before inserting. Match on title + creator, since `title` holds the title only (the artist lives in `author_creator`).
2. **Fetch a cover image** → goes in `cover_image_url`:
   - Movies/TV: TMDB at `w500` size
   - Books: Open Library by ISBN-L; if the response is a placeholder (43 bytes), find an alternate source
   - Albums/Singles: iTunes Search API (`entity=album` or `entity=musicTrack`); rewrite `100x100bb` → `600x600bb` in the returned `artworkUrl100`
3. **Write a description** — max 300 chars; no character names, actor names, director names, or place names. Goes in `description`.
4. **INSERT via `execute_sql`** directly against the MCP endpoint using the real [Database Schema](#database-schema) (`type`, `title`, `author_creator`, `genre`, `release_year`, `description`, `cover_image_url`) — do **NOT** use the `add_media_item` tool (wrong schema).

### Offering Suggestions

When asked to suggest items:

1. **Query the full DB** to see everything already in it (avoid repeats)
2. **Analyze ratings** — high-rated items reveal taste; low-rated items signal what to avoid; weight suggestions accordingly
3. **Propose 8–10 items** across types with a brief rationale for why each fits the taste profile
4. **On confirmation**, run the add steps above for the whole batch in parallel where possible

### Key Rules

- Title vs. creator: `title` holds the work's title only; the artist/author/director goes in `author_creator`. Do not concatenate them.
- Descriptions: max 300 chars, no character names, actor names, director names, or place names → `description` column
- Cover images: TMDB `w500` for movies/TV; Open Library ISBN-L for books (43 bytes = placeholder, find alternate); iTunes API `artworkUrl100` rewritten to `600x600bb` for albums/singles → `cover_image_url` column
- All DB writes go through `execute_sql` directly using the real [Database Schema](#database-schema) — the built-in `add_media_item` tool uses the wrong schema and must not be used
- The live `media_items` table already supports all five types via `CHECK(type IN ('book','tv_show','movie','album','single'))` — no migration needed (note TV is `tv_show`, not `tv`)
