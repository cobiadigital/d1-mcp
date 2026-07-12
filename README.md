# d1-mcp

A Cloudflare Worker that implements an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server over JSON-RPC 2.0, giving AI clients SQL access to a Cloudflare D1 database. Built around a personal media catalog (books, movies, TV shows, albums, singles, podcasts) with ratings and tags.

The entire server lives in a single file: `src/index.ts`.

## Features

- **JSON-RPC 2.0** MCP endpoint at `/mcp` (also served at `/`) — supports single requests, batch arrays, and Server-Sent Events (`Accept: text/event-stream`)
- **Four MCP tools**: `list_tables`, `describe_table`, `execute_sql`, `add_media_item`
- **Optional Bearer token auth** via `MCP_AUTH_TOKEN`, plus a built-in **OAuth 2.0 + PKCE** flow for clients that need dynamic client registration (e.g. Claude web/desktop connectors)
- **CORS** enabled for all origins
- No external dependencies beyond Wrangler/Cloudflare Workers types — no database ORM, no framework

## Requirements

- Node.js
- A Cloudflare account with a D1 database
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

## Setup

```bash
npm install
```

Configure the D1 binding in `wrangler.toml` (already set up for the `d1-mcp-db` database):

```toml
[[d1_databases]]
binding = "DB"
database_name = "d1-mcp-db"
database_id = "<your-database-id>"
```

Optionally require Bearer auth on the `/mcp` endpoint:

```bash
wrangler secret put MCP_AUTH_TOKEN
```

If `MCP_AUTH_TOKEN` is unset, the server accepts unauthenticated requests.

## Commands

```bash
npm run dev          # Local dev server via Wrangler
npm run deploy       # Deploy to Cloudflare Workers
npm run type-check   # TypeScript type check (no emit)
```

There are no automated tests; `type-check` is the only verification step.

## HTTP Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/health` | GET | Health check (`{"status":"ok"}`) |
| `/mcp`, `/` | POST | MCP JSON-RPC 2.0 endpoint |
| `/.well-known/oauth-authorization-server` | GET | OAuth discovery metadata |
| `/register` | POST | OAuth dynamic client registration |
| `/authorize` | GET/POST | OAuth authorization page (PKCE) |
| `/token` | POST | OAuth token exchange |

### Authenticating to `/mcp`

Send `Authorization: Bearer <token>` where `<token>` is either:
- the static `MCP_AUTH_TOKEN` secret, or
- an access token obtained via the OAuth 2.0 + PKCE flow (`/register` → `/authorize` → `/token`)

If `MCP_AUTH_TOKEN` is not set and no token is supplied, requests are allowed through unauthenticated.

## MCP Tools

### `list_tables`
Lists all tables in the D1 database (queries `sqlite_master`).

### `describe_table`
Returns column info (`PRAGMA table_info`) and the `CREATE TABLE` statement for a given table.

**Args:** `table_name` (string, required)

### `execute_sql`
Runs arbitrary SQL. `SELECT`/`PRAGMA`/`EXPLAIN`/`WITH` statements are routed through `.all()`; everything else runs through `.run()`. Supports parameterized queries via `?` placeholders.

**Args:** `sql` (string, required), `params` (array, optional)

This is the primary tool for reading and writing the database, including curated inserts that follow the [Media Workflow](#media-workflow) below.

### `add_media_item`
Convenience insert into `media_items` that auto-fetches a cover image from the iTunes Search API (`entity` chosen by `type`: `book`→`ebook`, `movie`→`movie`, `tv_show`→`tvSeries`, `album`→`album`, `single`→`musicTrack`, `podcast`→`podcast`). For music, the artist is appended to the search term. The returned `artworkUrl100` is rewritten to `600x600bb` for a higher-resolution image. Image lookup failure is non-fatal — the row is still inserted with `cover_image_url = NULL`.

**Args:** `title`, `type` (required); `author_creator`, `genre`, `release_year`, `description`, `links` (optional)

This tool is fine for quick one-off adds, but it does **not** perform duplicate checking or the richer per-type image sourcing described in the Media Workflow — use `execute_sql` directly for curated adds.

## Database Schema

Live schema for the `d1-mcp-db` D1 database. Verify with `describe_table` if unsure.

### `media_items`

```sql
CREATE TABLE media_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL CHECK(type IN ('book','tv_show','movie','album','single','podcast')),
  title           TEXT NOT NULL,   -- title only, e.g. "Sky Blue Sky" — not "Artist Title"
  author_creator  TEXT,            -- artist / author / director
  genre           TEXT,
  release_year    INTEGER,
  description     TEXT,            -- max 300 chars, no proper names
  cover_image_url TEXT,
  links           TEXT,            -- related URLs — single URL or JSON array
  external_id     TEXT,            -- e.g. iTunes/MusicBrainz id
  metadata        TEXT,            -- optional JSON blob
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Note: TV entries use `tv_show`, not `tv`.

### `ratings`

1–10 score with an optional review, unique per user + item.

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

### `tags` / `media_tags`

Many-to-many tagging.

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

Other tables present: `watchlist`, `user_preferences`, plus OAuth tables (`oauth_clients`, `oauth_auth_codes`, `oauth_tokens`) created on demand. Run `list_tables` / `describe_table` to inspect anything not documented here.

## Media Workflow

### Adding a specific item

1. **Check for duplicates** — `SELECT title, type, author_creator FROM media_items`, matching on title + creator.
2. **Fetch a cover image**:
   - Movies/TV: TMDB at `w500`
   - Books: Open Library by ISBN-L (a 43-byte response is a placeholder — find an alternate source)
   - Albums/Singles/Podcasts: iTunes Search API, rewriting `100x100bb` → `600x600bb`
3. **Write a description** — max 300 chars, no character/actor/director/place names.
4. **Insert via `execute_sql`** using the schema above (not `add_media_item`, which skips dedup and per-type sourcing).

### Offering suggestions

1. Query the full DB to avoid repeats.
2. Analyze `ratings` to infer taste (high-rated = lean in, low-rated = avoid).
3. Propose 8–10 items across types with a short rationale each.
4. On confirmation, add the batch in parallel following the steps above.

## Architecture Notes

- All requests hit the Worker's `fetch` handler → routing → `handleMessage()` → `callTool()` → D1.
- `env.DB.batch()` is used for multi-statement operations (e.g. `describe_table`).
- `isReadOnly()` decides `.all()` vs `.run()` for `execute_sql`.
- `isValidIdentifier()` guards table names interpolated into `PRAGMA` statements (which can't be parameterized) to prevent injection; value binding elsewhere uses parameterized queries.
- Tool errors are returned as JSON-RPC **results** with `isError: true`, not as JSON-RPC protocol errors.
- Schema changes (`ALTER TABLE`, etc.) do not deploy automatically — deploying only redeploys the Worker code. Run migrations against the live D1 manually via `execute_sql`.
