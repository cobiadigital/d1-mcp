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
          description: 'Title of the book, TV show, movie, album, or single',
        },
        media_type: {
          type: 'string',
          enum: ['book', 'movie', 'tv', 'album', 'single'],
          description: 'Type of media: book, movie, tv, album, or single',
        },
        notes: {
          type: 'string',
          description: 'Optional notes or description',
        },
      },
      required: ['title', 'media_type'],
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
    const mediaType = args['media_type'];
    const notes = args['notes'] ?? null;

    if (typeof title !== 'string' || !title) {
      throw new Error('title is required and must be a string');
    }
    if (mediaType !== 'book' && mediaType !== 'movie' && mediaType !== 'tv' && mediaType !== 'album' && mediaType !== 'single') {
      throw new Error('media_type must be one of: book, movie, tv, album, single');
    }

    // Look up cover image from iTunes Search API (free, no key required)
    const entityMap: Record<string, string> = { book: 'ebook', movie: 'movie', tv: 'tvSeries', album: 'album', single: 'musicTrack' };
    let imageUrl: string | null = null;
    try {
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=${entityMap[mediaType]}&limit=1`;
      const resp = await fetch(searchUrl);
      if (resp.ok) {
        const data = (await resp.json()) as { results?: Array<{ artworkUrl100?: string }> };
        const art = data.results?.[0]?.artworkUrl100;
        if (art) {
          // Swap in 600x600 variant — same CDN path, just different size token
          imageUrl = art.replace('100x100bb', '600x600bb');
        }
      }
    } catch {
      // Image lookup failure is non-fatal; item is still inserted
    }

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK(media_type IN ('book', 'movie', 'tv', 'album', 'single')),
          image_url TEXT,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      )
      .run();

    const result = await db
      .prepare('INSERT INTO media_items (title, media_type, image_url, notes) VALUES (?, ?, ?, ?)')
      .bind(title, mediaType, imageUrl, typeof notes === 'string' ? notes : null)
      .run();

    return { id: result.meta.last_row_id, title, media_type: mediaType, image_url: imageUrl, notes };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok' });
    }

    // Only handle /mcp endpoint
    if (url.pathname !== '/mcp') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    // Auth check
    if (env.MCP_AUTH_TOKEN) {
      const authHeader = request.headers.get('Authorization') ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== env.MCP_AUTH_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
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

    const wantsSSE =
      (request.headers.get('Accept') ?? '').includes('text/event-stream');

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
