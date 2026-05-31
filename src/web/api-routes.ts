import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { getDb } from '../memory/index.js';
import { getHistory } from '../memory/conversations.js';
import { getAppHome, getConfigPath } from '../utils/paths.js';
import { readConfig, writeConfig } from './config-api.js';
import { registerSchedulerRoutes } from '../scheduler/api-handlers.js';
import { registerNotificationRoutes } from '../intelligence/notification-api.js';
import { registerMemoryRoutes } from '../intelligence/memory-api.js';
import { registerWorkspaceContextRoutes } from '../intelligence/workspace-context-api.js';
import { registerPluginScopeRoutes } from '../intelligence/plugin-scope-api.js';
import { registerTemplateRoutes } from '../intelligence/template-api.js';
import { registerAsyncDelegationRoutes } from '../intelligence/async-delegation-api.js';
import { registerTeamBuilderRoutes } from '../intelligence/team-builder-api.js';
import { registerProviderRoutes } from '../providers/api-routes.js';
import type { WebServerDependencies } from './types.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.xml': 'text/xml',
};

type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>;

function camelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function createApiRouter(deps: WebServerDependencies) {
  const routes: Route[] = [];

  function route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^/api${pattern}$`), paramNames, handler });
  }

  route('GET', '/health', (_req, res) => {
    const agentStatuses = deps.agentManager.getStatus();
    json(res, {
      ok: true,
      uptime: (Date.now() - deps.startTimeMs) / 1000,
      agents: typeof agentStatuses === 'object' ? Object.keys(agentStatuses).length : 0,
    });
  });

  route('GET', '/config', (_req, res) => {
    const config = readConfig(getConfigPath());
    json(res, config);
  });

  route('PUT', '/config', async (req, res) => {
    const body = await readBody(req);
    const result = writeConfig(getConfigPath(), body);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { ok: true });
  });

  route('GET', '/config/defaults', (_req, res) => {
    json(res, {
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', baseUrl: '', apiKey: '' },
      budget: { sessionLimit: 100000, agentLimit: 50000, taskLimit: 20000, dailyLimit: 500000 },
      memory: { evolutionEnabled: true, consolidationInterval: 3600, maxResults: 10 },
      skills: { promptMode: 'hybrid', maxPromptChars: 4000, maxDescriptionChars: 200, shellInjection: false },
      observability: { level: 'info', captureOutput: true },
      web: { enabled: true, port: 3888, host: '127.0.0.1' },
    });
  });

  route('GET', '/agents', (_req, res) => {
    const list = deps.agentLifecycle.list({});
    json(res, list.map((r) => camelKeys(r as unknown as Record<string, unknown>)));
  });

  route('GET', '/agents/:name', (_req, res, _url, params) => {
    const info = deps.agentLifecycle.inspect(params.name);
    if (!info) { notFound(res); return; }
    json(res, camelKeys(info as unknown as Record<string, unknown>));
  });

  route('POST', '/agents/:name/enable', (_req, res, _url, params) => {
    deps.agentLifecycle.enable(params.name);
    json(res, { ok: true });
  });

  route('POST', '/agents/:name/disable', async (req, res, _url, params) => {
    const body = await readBody(req).catch(() => ({}));
    deps.agentLifecycle.disable(params.name, (body as Record<string, unknown>).reason as string | undefined);
    json(res, { ok: true });
  });

  route('GET', '/tasks', (_req, res, url) => {
    const limit = safeInt(url.searchParams.get('limit'), 20, 1, 200);
    const offset = safeInt(url.searchParams.get('offset'), 0);
    const status = url.searchParams.get('status') ?? undefined;
    const agent = url.searchParams.get('agent') ?? undefined;
    const db = getDb();

    const conditions: string[] = [];
    const filterParams: unknown[] = [];

    if (status) {
      conditions.push('status = ?');
      filterParams.push(status);
    }
    if (agent) {
      conditions.push('target_agent = ?');
      filterParams.push(agent);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM agent_tasks ${whereClause}`).get(...filterParams) as { cnt: number }).cnt;
    const rows = db.prepare(`SELECT * FROM agent_tasks ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...filterParams, limit, offset);
    json(res, { items: rows.map((r) => camelKeys(r as Record<string, unknown>)), total });
  });

  route('GET', '/tasks/:id', (_req, res, _url, params) => {
    const task = deps.taskManager.getTask(params.id);
    if (!task) { notFound(res); return; }
    json(res, camelKeys(task as unknown as Record<string, unknown>));
  });

  route('POST', '/tasks/:id/cancel', async (req, res, _url, params) => {
    const body = await readBody(req).catch(() => ({}));
    const reason = (body as Record<string, unknown>).reason as string | undefined ?? 'Cancelled via web dashboard';
    deps.taskManager.cancel(params.id, reason);
    json(res, { ok: true });
  });

  route('GET', '/conversations', (_req, res, url) => {
    const limit = safeInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = safeInt(url.searchParams.get('offset'), 0);
    const search = url.searchParams.get('search') ?? undefined;
    const sort = url.searchParams.get('sort') ?? 'recent';
    const db = getDb();

    let whereClause = '';
    const params: unknown[] = [];
    if (search) {
      whereClause = 'WHERE (c.session_id LIKE ? OR m.title LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const orderBy = sort === 'messages' ? 'message_count DESC' : 'last_active DESC';

    const rows = db.prepare(`
      SELECT c.session_id, COUNT(*) as message_count, MAX(c.created_at) as last_active,
        (SELECT content FROM conversations WHERE session_id = c.session_id ORDER BY created_at ASC LIMIT 1) as first_message,
        m.title
      FROM conversations c
      LEFT JOIN conversation_meta m ON m.session_id = c.session_id
      ${whereClause}
      GROUP BY c.session_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    json(res, rows.map((r) => camelKeys(r as Record<string, unknown>)));
  });

  route('GET', '/conversations/:sid', (_req, res, url, params) => {
    const limit = safeInt(url.searchParams.get('limit'), 200, 1, 500);
    const messages = getHistory(params.sid, limit);
    json(res, messages);
  });

  route('DELETE', '/conversations/:sid', (_req, res, _url, params) => {
    const db = getDb();
    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM conversations WHERE session_id = ?').run(params.sid);
      db.prepare('DELETE FROM conversation_meta WHERE session_id = ?').run(params.sid);
    });
    deleteAll();
    json(res, { ok: true });
  });

  // --- Conversation rename ---
  route('PUT', '/conversations/:sid', async (req, res, _url, params) => {
    const body = await readBody(req).catch(() => ({})) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : null;
    if (!title) { json(res, { error: 'title is required' }, 400); return; }
    const db = getDb();
    db.prepare(`INSERT INTO conversation_meta (session_id, title, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`)
      .run(params.sid, title, Date.now());
    json(res, { ok: true });
  });

  // --- Full-text search ---
  route('GET', '/search', (_req, res, url) => {
    const q = url.searchParams.get('q')?.trim();
    if (!q) { json(res, { results: [], total: 0 }); return; }
    const limit = safeInt(url.searchParams.get('limit'), 20, 1, 100);
    const offset = safeInt(url.searchParams.get('offset'), 0);
    const db = getDb();

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM conversations WHERE content LIKE ?`).get(`%${q}%`) as { cnt: number };
    const rows = db.prepare(`
      SELECT id, session_id, role, content, created_at FROM conversations
      WHERE content LIKE ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(`%${q}%`, limit, offset) as Record<string, unknown>[];

    const results = rows.map((r) => ({
      sessionId: r.session_id,
      content: r.content,
      role: r.role,
      createdAt: r.created_at,
      highlight: highlightSnippet(r.content as string, q),
    }));
    json(res, { results, total: countRow.cnt });
  });

  // --- Task stats ---
  route('GET', '/tasks/stats', (_req, res, url) => {
    const days = safeInt(url.searchParams.get('days'), 7, 1, 90);
    const db = getDb();
    const since = Date.now() - days * 86400000;

    const rows = db.prepare(`
      SELECT
        CAST((created_at / 86400000) AS INTEGER) as day_bucket,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks
      WHERE created_at >= ?
      GROUP BY day_bucket
      ORDER BY day_bucket ASC
    `).all(since) as { day_bucket: number; completed: number; failed: number }[];

    const result: { date: string; completed: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayMs = Date.now() - i * 86400000;
      const bucket = Math.floor(dayMs / 86400000);
      const row = rows.find((r) => r.day_bucket === bucket);
      const date = new Date(bucket * 86400000).toISOString().slice(0, 10);
      result.push({ date, completed: row?.completed ?? 0, failed: row?.failed ?? 0 });
    }
    json(res, result);
  });

  // --- Token usage summary ---
  route('GET', '/usage/summary', (_req, res, url) => {
    const days = safeInt(url.searchParams.get('days'), 7, 1, 90);
    const db = getDb();
    const now = Date.now();
    const todayStart = now - (now % 86400000);
    const periodStart = now - days * 86400000;

    const todayRow = db.prepare(`
      SELECT COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
      FROM token_usage WHERE created_at >= ?
    `).get(todayStart) as Record<string, number>;

    const periodRow = db.prepare(`
      SELECT COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
      FROM token_usage WHERE created_at >= ?
    `).get(periodStart) as Record<string, number>;

    const dailyRows = db.prepare(`
      SELECT CAST((created_at / 86400000) AS INTEGER) as day_bucket,
        COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
      FROM token_usage WHERE created_at >= ?
      GROUP BY day_bucket ORDER BY day_bucket ASC
    `).all(periodStart) as { day_bucket: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number }[];

    const daily: { date: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayMs = now - i * 86400000;
      const bucket = Math.floor(dayMs / 86400000);
      const row = dailyRows.find((r) => r.day_bucket === bucket);
      daily.push({
        date: new Date(bucket * 86400000).toISOString().slice(0, 10),
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        totalTokens: row?.total_tokens ?? 0,
        costUsd: row?.cost_usd ?? 0,
      });
    }

    const byAgent = db.prepare(`
      SELECT agent_name, COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
      FROM token_usage WHERE created_at >= ? AND agent_name IS NOT NULL
      GROUP BY agent_name ORDER BY total_tokens DESC
    `).all(periodStart) as { agent_name: string; total_tokens: number; cost_usd: number }[];

    const byModel = db.prepare(`
      SELECT model, COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
      FROM token_usage WHERE created_at >= ?
      GROUP BY model ORDER BY total_tokens DESC
    `).all(periodStart) as { model: string; total_tokens: number; cost_usd: number }[];

    json(res, {
      today: camelKeys(todayRow as unknown as Record<string, unknown>),
      period: camelKeys(periodRow as unknown as Record<string, unknown>),
      daily,
      byAgent: byAgent.map((r) => ({ agentName: r.agent_name, totalTokens: r.total_tokens, costUsd: r.cost_usd })),
      byModel: byModel.map((r) => ({ model: r.model, totalTokens: r.total_tokens, costUsd: r.cost_usd })),
    });
  });

  // --- File upload ---
  route('POST', '/upload', async (req, res) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      json(res, { error: 'multipart/form-data required' }, 400);
      return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) { json(res, { error: 'missing boundary' }, 400); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_UPLOAD_SIZE) { req.destroy(); json(res, { error: 'File too large (max 10MB)' }, 413); return; }
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    const parsed = parseMultipart(buffer, boundary);
    if (!parsed) { json(res, { error: 'Could not parse file' }, 400); return; }

    const uploadsDir = join(getAppHome(), 'data', 'uploads');
    mkdirSync(uploadsDir, { recursive: true });

    const ext = extname(parsed.filename).toLowerCase() || '.bin';
    const fileId = randomUUID();
    const filePath = join(uploadsDir, `${fileId}${ext}`);
    writeFileSync(filePath, parsed.data);

    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
    json(res, {
      fileId: `${fileId}${ext}`,
      filename: parsed.filename,
      mimeType,
      size: parsed.data.length,
      url: `/api/files/${fileId}${ext}`,
    });
  });

  // --- File serve ---
  route('GET', '/files/:fileId', (_req, res, _url, params) => {
    const uploadsDir = resolve(join(getAppHome(), 'data', 'uploads'));
    const filePath = resolve(join(uploadsDir, params.fileId));
    if (!filePath.startsWith(uploadsDir) || !existsSync(filePath)) {
      notFound(res);
      return;
    }
    const ext = extname(params.fileId).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const stat = statSync(filePath);
    res.writeHead(200, {
      'content-type': mimeType,
      'content-length': stat.size,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
  });

  // --- Scheduler routes ---
  registerSchedulerRoutes(route, () => deps.schedulerService, readBody, json);

  // --- Notification routes ---
  registerNotificationRoutes(route, () => deps.notificationService, readBody, json);

  // --- Memory routes ---
  registerMemoryRoutes(route, () => deps.memoryLayerService, readBody, json);

  // --- Workspace context routes ---
  registerWorkspaceContextRoutes(route, () => deps.workspaceContextService, readBody, json);

  // --- Plugin scope routes ---
  registerPluginScopeRoutes(route, () => deps.pluginScopeService, readBody, json);

  // --- Template routes ---
  registerTemplateRoutes(route, () => deps.templateService, readBody, json);

  // --- Async delegation routes ---
  registerAsyncDelegationRoutes(route, () => deps.asyncDelegationService, readBody, json);

  // --- Team builder routes ---
  registerTeamBuilderRoutes(route, () => deps.teamBuilderService, readBody, json);

  // --- Provider management routes ---
  registerProviderRoutes(route, () => deps.providerRegistry, readBody, json);

  return function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const method = req.method ?? 'GET';

    setCorsHeaders(res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    for (const r of routes) {
      if (r.method !== method) continue;
      const match = url.pathname.match(r.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

      try {
        const result = r.handler(req, res, url, params);
        if (result instanceof Promise) {
          result.catch((err) => {
            if (!res.headersSent) serverError(res, err);
            else getLogger('api').error({ err }, 'Error after headers sent');
          });
        }
      } catch (err) {
        if (!res.headersSent) serverError(res, err);
      }
      return;
    }

    notFound(res);
  };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not Found' }, 404);
}

function serverError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  json(res, { error: message }, 500);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function safeInt(raw: string | null, fallback: number, min = 0, max = Infinity): number {
  const n = parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '3600');
}

function highlightSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, 100);
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 40);
  let snippet = '';
  if (start > 0) snippet += '...';
  snippet += content.slice(start, end);
  if (end < content.length) snippet += '...';
  return snippet;
}

function parseMultipart(buffer: Buffer, boundary: string): { filename: string; data: Buffer } | null {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const start = buffer.indexOf(boundaryBuf);
  if (start === -1) return null;

  const headerEnd = buffer.indexOf('\r\n\r\n', start);
  if (headerEnd === -1) return null;

  const headers = buffer.slice(start + boundaryBuf.length + 2, headerEnd).toString();
  const filenameMatch = headers.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] ?? 'upload.bin';

  const dataStart = headerEnd + 4;
  const nextBoundary = buffer.indexOf(boundaryBuf, dataStart);
  const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : buffer.length;

  return { filename, data: buffer.slice(dataStart, dataEnd) };
}
