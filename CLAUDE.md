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

Three tools defined in the `TOOLS` constant array:
1. **`list_tables`** — queries `sqlite_master` for all tables
2. **`describe_table`** — returns schema/column info for a named table
3. **`execute_sql`** — runs arbitrary SQL with optional `params` array for parameterized queries

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
