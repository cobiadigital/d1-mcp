export interface Env {
  DB: D1Database;
  MCP_AUTH_TOKEN?: string;
}

// JSON-RPC 2.0 types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// MCP tool definitions
const TOOLS = [
  {
    name: 'list_tables',
    description: 'List all tables in the D1 database',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'describe_table',
    description: 'Get the schema and column info for a table',
    inputSchema: {
      type: 'object',
      properties: {
        table_name: {
          type: 'string',
          description: 'The name of the table to describe',
        },
      },
      required: ['table_name'],
    },
  },
  {
    name: 'execute_sql',
    description:
      'Execute any SQL statement against the D1 database. Use SELECT for reads, INSERT/UPDATE/DELETE/CREATE/DROP for writes.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL statement to execute',
        },
        params: {
          type: 'array',
          description: 'Optional positional parameters for parameterized queries (use ? placeholders)',
          items: {},
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'add_media_item',
    description:
      'Add a book, TV show, movie, album, or single to the media_items table. Automatically looks up a cover image from the iTunes Search API. Creates the table if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work only (e.g. "Sky Blue Sky") — not "Artist - Title"',
        },
        type: {
          type: 'string',
          enum: ['book', 'movie', 'tv_show', 'album', 'single'],
          description: 'Type of media: book, movie, tv_show, album, or single',
        },
        author_creator: {
          type: 'string',
          description: 'Artist, author, or director — the creator of the work',
        },
        genre: {
          type: 'string',
          description: 'Optional genre',
        },
        release_year: {
          type: 'integer',
          description: 'Optional release year',
        },
        description: {
          type: 'string',
          description: 'Optional description (max 300 chars; no character/actor/director/place names)',
        },
      },
      required: ['title', 'type'],
    },
  },
];

// Safe identifier check for table names used in PRAGMA (can't be parameterized)
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// Check if SQL is a read-only statement
function isReadOnly(sql: string): boolean {
  const normalized = sql.trimStart().toUpperCase();
  return (
    normalized.startsWith('SELECT') ||
    normalized.startsWith('PRAGMA') ||
    normalized.startsWith('EXPLAIN') ||
    normalized.startsWith('WITH')
  );
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  db: D1Database
): Promise<unknown> {
  if (name === 'list_tables') {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    return { tables: result.results.map((r) => r.name) };
  }

  if (name === 'describe_table') {
    const tableName = args['table_name'];
    if (typeof tableName !== 'string' || !tableName) {
      throw new Error('table_name is required and must be a string');
    }
    if (!isValidIdentifier(tableName)) {
      throw new Error('Invalid table name');
    }
    const [columns, ddl] = await db.batch([
      db.prepare(`PRAGMA table_info(${tableName})`),
      db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).bind(tableName),
    ]);
    return {
      columns: columns.results,
      ddl: (ddl.results[0] as { sql: string } | undefined)?.sql ?? null,
    };
  }

  if (name === 'execute_sql') {
    const sql = args['sql'];
    const params = args['params'];
    if (typeof sql !== 'string' || !sql) {
      throw new Error('sql is required and must be a string');
    }
    const bindParams = Array.isArray(params) ? params : [];
    const stmt = db.prepare(sql).bind(...bindParams);
    if (isReadOnly(sql)) {
      const result = await stmt.all();
      return { rows: result.results, meta: result.meta };
    } else {
      const result = await stmt.run();
      return { meta: result.meta, success: result.success };
    }
  }

  if (name === 'add_media_item') {
    const title = args['title'];
    const type = args['type'];
    const authorCreator = typeof args['author_creator'] === 'string' ? args['author_creator'] : null;
    const genre = typeof args['genre'] === 'string' ? args['genre'] : null;
    const releaseYear = typeof args['release_year'] === 'number' ? args['release_year'] : null;
    const description = typeof args['description'] === 'string' ? args['description'] : null;

    if (typeof title !== 'string' || !title) {
      throw new Error('title is required and must be a string');
    }
    if (type !== 'book' && type !== 'movie' && type !== 'tv_show' && type !== 'album' && type !== 'single') {
      throw new Error('type must be one of: book, movie, tv_show, album, single');
    }

    // Look up cover image from iTunes Search API (free, no key required).
    // For music, include the artist in the search term for better matches.
    const entityMap: Record<string, string> = { book: 'ebook', movie: 'movie', tv_show: 'tvSeries', album: 'album', single: 'musicTrack' };
    const searchTerm = authorCreator ? `${title} ${authorCreator}` : title;
    let coverImageUrl: string | null = null;
    try {
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=${entityMap[type]}&limit=1`;
      const resp = await fetch(searchUrl);
      if (resp.ok) {
        const data = (await resp.json()) as { results?: Array<{ artworkUrl100?: string }> };
        const art = data.results?.[0]?.artworkUrl100;
        if (art) {
          // Swap in 600x600 variant — same CDN path, just different size token
          coverImageUrl = art.replace('100x100bb', '600x600bb');
        }
      }
    } catch {
      // Image lookup failure is non-fatal; item is still inserted
    }

    // Matches the live D1 schema (see CLAUDE.md → Database Schema).
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('book', 'tv_show', 'movie', 'album', 'single')),
          title TEXT NOT NULL,
          author_creator TEXT,
          genre TEXT,
          release_year INTEGER,
          description TEXT,
          cover_image_url TEXT,
          external_id TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      )
      .run();

    const result = await db
      .prepare(
        'INSERT INTO media_items (type, title, author_creator, genre, release_year, description, cover_image_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(type, title, authorCreator, genre, releaseYear, description, coverImageUrl)
      .run();

    return { id: result.meta.last_row_id, type, title, author_creator: authorCreator, genre, release_year: releaseYear, description, cover_image_url: coverImageUrl };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

async function handleMessage(
  request: JsonRpcRequest,
  db: D1Database
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  // Notifications (no id) — acknowledge but don't respond
  if (request.id === undefined) {
    return null;
  }

  const { method, params } = request;

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'd1-mcp', version: '1.0.0' },
    });
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!p?.name) {
      return jsonRpcError(id, -32602, 'Invalid params: missing tool name');
    }
    try {
      const output = await callTool(p.name, p.arguments ?? {}, db);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
};

function sseResponse(data: JsonRpcResponse): Response {
  const body = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ===== OAuth 2.0 =====

function generateSecureToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pkceVerify(verifier: string, challenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(digest);
  let binary = '';
  for (const byte of arr) binary += String.fromCharCode(byte);
  const b64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return b64url === challenge;
}

async function ensureOAuthTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oauthMetadata(request: Request): Response {
  const { protocol, host } = new URL(request.url);
  const base = `${protocol}//${host}`;
  return jsonResponse({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

async function handleRegister(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  await ensureOAuthTables(db);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'invalid_request', error_description: 'Invalid JSON' }, 400);
  }

  const uris = body['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'redirect_uris must be a non-empty string array' },
      400
    );
  }

  const clientId = generateSecureToken(16);
  const clientName = typeof body['client_name'] === 'string' ? body['client_name'] : null;

  await db
    .prepare('INSERT INTO oauth_clients (id, redirect_uris, name) VALUES (?, ?, ?)')
    .bind(clientId, JSON.stringify(uris), clientName)
    .run();

  return jsonResponse(
    {
      client_id: clientId,
      redirect_uris: uris,
      client_name: clientName,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201
  );
}

function renderAuthPage(opts: {
  fields: Record<string, string>;
  clientName: string;
  requirePassword: boolean;
  error?: string;
}): Response {
  const hiddenInputs = Object.entries(opts.fields)
    .map(([n, v]) => `<input type="hidden" name="${escapeHtml(n)}" value="${escapeHtml(v)}">`)
    .join('\n      ');

  const errorBlock = opts.error
    ? `<p class="error">${escapeHtml(opts.error)}</p>`
    : '';

  const pwBlock = opts.requirePassword
    ? `<div class="field">
        <label for="pw">Password</label>
        <input type="password" id="pw" name="password" autocomplete="current-password" required>
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize – D1 MCP</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f4f4f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;border-radius:12px;padding:36px;width:100%;max-width:420px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
    h1{margin:0 0 6px;font-size:1.25rem}
    .sub{color:#555;margin:0 0 24px;font-size:.9rem}
    .field{margin-bottom:18px}
    label{display:block;font-size:.875rem;font-weight:600;margin-bottom:6px}
    input[type=password]{width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:7px;font-size:1rem}
    input[type=password]:focus{outline:2px solid #2563eb;border-color:transparent}
    .error{color:#dc2626;font-size:.875rem;margin:0 0 16px;padding:10px 12px;background:#fef2f2;border-radius:6px}
    button{width:100%;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:1rem;font-weight:600;cursor:pointer;margin-top:4px}
    button:hover{background:#1d4ed8}
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p class="sub"><strong>${escapeHtml(opts.clientName)}</strong> is requesting access to your D1 MCP database.</p>
    ${errorBlock}
    <form method="POST" action="/authorize">
      ${hiddenInputs}
      ${pwBlock}
      <button type="submit">Approve</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

type OAuthClient = { id: string; redirect_uris: string; name: string | null };

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  await ensureOAuthTables(env.DB);

  const getStr = (src: URLSearchParams | FormData, key: string): string =>
    (src.get(key) ?? '').toString();

  if (request.method === 'GET') {
    const sp = new URL(request.url).searchParams;

    if (getStr(sp, 'response_type') !== 'code') {
      return new Response('Invalid response_type: must be "code"', { status: 400 });
    }

    const clientId = getStr(sp, 'client_id');
    const redirectUri = getStr(sp, 'redirect_uri');

    const client = await env.DB.prepare('SELECT id, redirect_uris, name FROM oauth_clients WHERE id = ?')
      .bind(clientId)
      .first<OAuthClient>();
    if (!client) return new Response('Unknown client_id', { status: 400 });

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
    if (!allowedUris.includes(redirectUri)) return new Response('Invalid redirect_uri', { status: 400 });

    return renderAuthPage({
      fields: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: getStr(sp, 'state'),
        code_challenge: getStr(sp, 'code_challenge'),
        code_challenge_method: getStr(sp, 'code_challenge_method'),
      },
      clientName: client.name ?? clientId,
      requirePassword: !!env.MCP_AUTH_TOKEN,
    });
  }

  if (request.method === 'POST') {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return new Response('Invalid form data', { status: 400 });
    }

    const clientId = getStr(form, 'client_id');
    const redirectUri = getStr(form, 'redirect_uri');
    const state = getStr(form, 'state');
    const codeChallenge = getStr(form, 'code_challenge');
    const codeChallengeMethod = getStr(form, 'code_challenge_method');
    const password = getStr(form, 'password');

    const client = await env.DB.prepare('SELECT id, redirect_uris, name FROM oauth_clients WHERE id = ?')
      .bind(clientId)
      .first<OAuthClient>();
    if (!client) return new Response('Unknown client_id', { status: 400 });

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
    if (!allowedUris.includes(redirectUri)) return new Response('Invalid redirect_uri', { status: 400 });

    if (env.MCP_AUTH_TOKEN && password !== env.MCP_AUTH_TOKEN) {
      return renderAuthPage({
        fields: { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod },
        clientName: client.name ?? clientId,
        requirePassword: true,
        error: 'Incorrect password.',
      });
    }

    const code = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await env.DB.prepare(
      'INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(code, clientId, redirectUri, codeChallenge || null, codeChallengeMethod || null, expiresAt)
      .run();

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    return Response.redirect(redirect.toString(), 302);
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}

async function handleToken(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  await ensureOAuthTables(db);

  let params: URLSearchParams;
  const ct = request.headers.get('Content-Type') ?? '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      params = new URLSearchParams(await request.text());
    } else {
      const obj = (await request.json()) as Record<string, string>;
      params = new URLSearchParams(obj);
    }
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }

  if (params.get('grant_type') !== 'authorization_code') {
    return jsonResponse({ error: 'unsupported_grant_type' }, 400);
  }

  const code = params.get('code') ?? '';
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeVerifier = params.get('code_verifier') ?? '';

  type AuthCodeRow = {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string | null;
    code_challenge_method: string | null;
    expires_at: string;
    used: number;
  };

  const row = await db
    .prepare('SELECT * FROM oauth_auth_codes WHERE code = ? AND used = 0')
    .bind(code)
    .first<AuthCodeRow>();

  if (!row) return jsonResponse({ error: 'invalid_grant', error_description: 'Invalid or expired code' }, 400);
  if (new Date(row.expires_at) < new Date()) return jsonResponse({ error: 'invalid_grant', error_description: 'Code expired' }, 400);
  if (row.client_id !== clientId) return jsonResponse({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
  if (row.redirect_uri !== redirectUri) return jsonResponse({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);

  if (row.code_challenge) {
    if (!codeVerifier) return jsonResponse({ error: 'invalid_grant', error_description: 'code_verifier required' }, 400);
    if (!(await pkceVerify(codeVerifier, row.code_challenge))) {
      return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
  }

  await db.prepare('UPDATE oauth_auth_codes SET used = 1 WHERE code = ?').bind(code).run();

  const token = generateSecureToken(32);
  await db.prepare('INSERT INTO oauth_tokens (token, client_id) VALUES (?, ?)').bind(token, clientId).run();

  return jsonResponse({ access_token: token, token_type: 'bearer' });
}

// ===== Main fetch handler =====

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // OAuth discovery — no auth required
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return oauthMetadata(request);
    }

    // OAuth endpoints — no auth required
    if (url.pathname === '/register') return handleRegister(request, env.DB);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/token') return handleToken(request, env.DB);

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok' });
    }

    // Only handle /mcp endpoint below
    if (url.pathname !== '/mcp') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    // Auth: accept static MCP_AUTH_TOKEN OR a valid OAuth token.
    // If neither is configured and no token is provided, allow open access.
    const authHeader = request.headers.get('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let authorized = !env.MCP_AUTH_TOKEN && !bearerToken;

    if (!authorized) {
      if (env.MCP_AUTH_TOKEN && bearerToken === env.MCP_AUTH_TOKEN) {
        authorized = true;
      } else if (bearerToken) {
        try {
          const row = await env.DB.prepare('SELECT 1 FROM oauth_tokens WHERE token = ?')
            .bind(bearerToken)
            .first();
          if (row) authorized = true;
        } catch {
          // oauth_tokens table not yet created — not authorized via OAuth
        }
      }
    }

    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400);
    }

    const wantsSSE = (request.headers.get('Accept') ?? '').includes('text/event-stream');

    // Handle batch requests
    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of body as JsonRpcRequest[]) {
        const resp = await handleMessage(item, env.DB);
        if (resp !== null) responses.push(resp);
      }
      if (responses.length === 0) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }
      return wantsSSE
        ? sseResponse(responses as unknown as JsonRpcResponse)
        : jsonResponse(responses);
    }

    // Single request
    const rpcRequest = body as JsonRpcRequest;
    const response = await handleMessage(rpcRequest, env.DB);

    if (response === null) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    return wantsSSE ? sseResponse(response) : jsonResponse(response);
  },
};
