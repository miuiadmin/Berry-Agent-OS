import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLogger, resolveEffectiveLevel } from '../utils/logger.js';
import { registerCaptureRoutes } from '../observability/index.js';
import { metrics } from '../observability/metrics.js';
import { MS_PER_DAY } from '../lib/time-constants.js';
import { getDb } from '../memory/index.js';
import { getHistory } from '../memory/conversations.js';
import { getAppHome } from '../utils/paths.js';
import type { IConfigService } from '../config/contract.js';
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
    const logLevel = resolveEffectiveLevel();
    json(res, {
      ok: true,
      uptime: (Date.now() - deps.startTimeMs) / 1000,
      agents: typeof agentStatuses === 'object' ? Object.keys(agentStatuses).length : 0,
      logLevel,
      debugMode: logLevel === 'debug',
    });
  });

  route('GET', '/config', (_req, res) => {
    const config = deps.configService.get();
    json(res, config);
  });

  route('PUT', '/config', async (req, res) => {
    const body = await readBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      json(res, { error: 'Request body must be a JSON object' }, 400);
      return;
    }
    const result = deps.configService.updateSection(body as Partial<import('../config/types.js').AppConfig>);
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

  // --- Task stats (must be registered BEFORE /tasks/:id to avoid route shadowing) ---
  route('GET', '/tasks/stats', (_req, res, url) => {
    const days = safeInt(url.searchParams.get('days'), 7, 1, 90);
    const db = getDb();
    const since = Date.now() - days * MS_PER_DAY;

    const rows = db.prepare(`
      SELECT
        CAST((created_at / ${MS_PER_DAY}) AS INTEGER) as day_bucket,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks
      WHERE created_at >= ?
      GROUP BY day_bucket
      ORDER BY day_bucket ASC
    `).all(since) as { day_bucket: number; completed: number; failed: number }[];

    const result: { date: string; completed: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayMs = Date.now() - i * MS_PER_DAY;
      const bucket = Math.floor(dayMs / MS_PER_DAY);
      const row = rows.find((r) => r.day_bucket === bucket);
      const date = new Date(bucket * MS_PER_DAY).toISOString().slice(0, 10);
      result.push({ date, completed: row?.completed ?? 0, failed: row?.failed ?? 0 });
    }
    json(res, result);
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

  // --- Session state (for reconnection recovery) ---
  route('GET', '/sessions/:sid/state', (_req, res, url, params) => {
    const db = getDb();
    const sessionId = params.sid;
    const limit = safeInt(url.searchParams.get('limit'), 200, 1, 500);

    // Active (non-terminal) tasks for this session（含 output_payload 用于恢复流式内容）
    const activeTasks = db.prepare(`
      SELECT id, status, target_agent, created_at, output_payload FROM agent_tasks
      WHERE session_id = ? AND status NOT IN ('completed','failed','timeout','cancelled')
      ORDER BY created_at DESC LIMIT 5
    `).all(sessionId) as Array<{ id: string; status: string; target_agent: string; created_at: number; output_payload: string | null }>;

    // Get all progress events for each active task (for thinking steps recovery)
    const tasksWithProgress = activeTasks.map((task) => {
      const events = db.prepare(`
        SELECT message, created_at FROM task_events
        WHERE task_id = ? AND event_type = 'progress'
        ORDER BY created_at ASC
      `).all(task.id) as Array<{ message: string; created_at: number }>;

      // 解析流式内容（StreamingFlusher 定期写入的中间文本）
      let streamingContent: string | null = null;
      let streamingReasoning: string | null = null;
      if (task.output_payload) {
        try {
          const parsed = JSON.parse(task.output_payload);
          if (parsed.streamingContent) streamingContent = parsed.streamingContent;
          if (parsed.reasoning) streamingReasoning = parsed.reasoning;
        } catch { /* 非 JSON 或格式不符，忽略 */ }
      }

      return {
        taskId: task.id,
        status: task.status,
        targetAgent: task.target_agent,
        createdAt: task.created_at,
        progress: events.length > 0 ? events[events.length - 1].message : null,
        thinkingSteps: events.map((e) => ({ text: e.message, ts: e.created_at })),
        streamingContent,
        streamingReasoning,
      };
    });

    // Conversation messages with thinkingSteps from task_events
    const rawMessages = getHistory(sessionId, limit);
    // 查询该 session 所有任务（不限 task_type），按时间正序排列。
    // 不使用 finished_at 时间窗口：conversation_turn 可能几百毫秒就结束，
    // 但 assistant 消息要等委派任务（如 code_task）跑完后才写入，时间差可达数十秒。
    const allTasks = db.prepare(`
      SELECT id, created_at FROM agent_tasks
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as Array<{ id: string; created_at: number }>;

    const messages = rawMessages.map((msg, idx) => {
      if (msg.role !== 'assistant') return msg;
      // 确定这轮对话的时间范围：前一条 assistant 消息之后 ~ 当前 assistant 消息。
      // 避免用 user 消息做下界：某些流程会插入重复的 user 消息，导致时间窗口错乱。
      let prevAssistantTime = 0;
      for (let i = idx - 1; i >= 0; i--) {
        if (rawMessages[i].role === 'assistant') {
          prevAssistantTime = rawMessages[i].createdAt;
          break;
        }
      }
      const taskIds = allTasks.filter((t) => t.created_at > prevAssistantTime && t.created_at <= msg.createdAt).map((t) => t.id);
      if (taskIds.length === 0) return msg;
      const placeholders = taskIds.map(() => '?').join(',');
      const steps = db.prepare(`
        SELECT message, created_at FROM task_events
        WHERE task_id IN (${placeholders}) AND event_type = 'progress'
        ORDER BY created_at ASC
      `).all(...taskIds) as Array<{ message: string; created_at: number }>;
      if (steps.length === 0) return msg;
      return { ...msg, thinkingSteps: steps.map((s) => ({ text: s.message, ts: s.created_at })) };
    });

    json(res, { sessionId, activeTasks: tasksWithProgress, messages });
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

  // R12-P3：审计查询端点
  // GET /api/audit/tool-calls?sessionId=...&limit=50
  // GET /api/audit/reviews?sessionId=...&limit=50
  route('GET', '/audit/tool-calls', (_req, res, url) => {
    const sessionId = url.searchParams.get('sessionId');
    const limit = safeInt(url.searchParams.get('limit'), 50, 1, 200);
    const db = getDb();
    const where = sessionId ? 'WHERE session_id = ?' : '';
    const params: unknown[] = sessionId ? [sessionId] : [];
    const rows = db.prepare(`
      SELECT id, session_id, agent_name, tool_name, input_json, output_json,
             status, danger_level, started_at, completed_at
      FROM tool_calls ${where}
      ORDER BY started_at DESC LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>;
    json(res, { rows, total: rows.length });
  });

  route('GET', '/audit/reviews', (_req, res, url) => {
    const sessionId = url.searchParams.get('sessionId');
    const limit = safeInt(url.searchParams.get('limit'), 50, 1, 200);
    const db = getDb();
    const where = sessionId ? 'WHERE session_id = ?' : '';
    const params: unknown[] = sessionId ? [sessionId] : [];
    const rows = db.prepare(`
      SELECT id, session_id, level, verdict, reason, created_at
      FROM review_requests ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>;
    json(res, { rows, total: rows.length });
  });

  // --- Token usage summary ---
  route('GET', '/usage/summary', (_req, res, url) => {
    const days = safeInt(url.searchParams.get('days'), 7, 1, 90);
    const db = getDb();
    const now = Date.now();
    const todayStart = now - (now % MS_PER_DAY);
    const periodStart = now - days * MS_PER_DAY;

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
      SELECT CAST((created_at / ${MS_PER_DAY}) AS INTEGER) as day_bucket,
        COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(input_tokens + output_tokens),0) as total_tokens, COALESCE(SUM(cost_usd),0) as cost_usd,
        COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens
      FROM token_usage WHERE created_at >= ?
      GROUP BY day_bucket ORDER BY day_bucket ASC
    `).all(periodStart) as { day_bucket: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number; cache_read_tokens: number; cache_creation_tokens: number }[];

    const daily: { date: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; cacheReadTokens: number; cacheCreationTokens: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayMs = now - i * MS_PER_DAY;
      const bucket = Math.floor(dayMs / MS_PER_DAY);
      const row = dailyRows.find((r) => r.day_bucket === bucket);
      daily.push({
        date: new Date(bucket * MS_PER_DAY).toISOString().slice(0, 10),
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        totalTokens: row?.total_tokens ?? 0,
        costUsd: row?.cost_usd ?? 0,
        cacheReadTokens: row?.cache_read_tokens ?? 0,
        cacheCreationTokens: row?.cache_creation_tokens ?? 0,
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
  registerProviderRoutes(route, () => deps.getProviderRegistry?.(), readBody, json, deps.configService);

  // --- 12.0 Drift metrics routes ---
  route('GET', '/drift/metrics', (_req, res, url) => {
    const days = safeInt(url.searchParams.get('days'), 7, 1, 90);
    try {
      const service = deps.getDriftMetrics?.();
      if (!service) { json(res, { error: 'drift metrics unavailable' }, 503); return; }
      const metrics = service.aggregate(days);
      json(res, metrics);
    } catch (err) {
      json(res, { error: 'drift metrics unavailable' }, 500);
    }
  });

  route('GET', '/drift/signals', (_req, res, url) => {
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const limit = safeInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = safeInt(url.searchParams.get('offset'), 0);
    try {
      const service = deps.getDriftMetrics?.();
      if (!service) { json(res, { error: 'drift signals unavailable' }, 503); return; }
      const signals = service.listSignals({ sessionId, limit, offset });
      json(res, { signals, total: signals.length });
    } catch (err) {
      json(res, { error: 'drift signals unavailable' }, 500);
    }
  });

  // --- Debug capture routes ---
  registerCaptureRoutes(route, json);

  // --- Logs viewer ---
  route('GET', '/logs', (_req, res, url) => {
    const count = safeInt(url.searchParams.get('lines'), 100, 10, 1000);
    const level = url.searchParams.get('level') ?? undefined;
    const module = url.searchParams.get('module') ?? undefined;
    const logFile = join(getAppHome(), 'logs', 'berry.log');
    if (!existsSync(logFile)) { json(res, { lines: [], total: 0 }); return; }

    const content = readFileSync(logFile, 'utf-8');
    const rawLines = content.split('\n').filter(Boolean).slice(-count * 3);
    const levelMap: Record<string, number> = { error: 50, warn: 40, info: 30, debug: 20 };
    const minLevel = level && level !== 'ALL' ? (levelMap[level.toLowerCase()] ?? 0) : 0;

    const parsed: unknown[] = [];
    for (const line of rawLines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.level === 'number' && obj.level < minLevel) continue;
        if (module && obj.module !== module) continue;
        parsed.push(obj);
      } catch { /* skip */ }
    }
    const result = parsed.slice(-count);
    json(res, { lines: result, total: result.length });
  });

  /**
   * R12-P1：暴露 Prometheus / 内部可观测性指标快照
   * 返回结构：
   *   { counters: [{ name, labels, value }], histograms: [{ name, labels, count, p50/p95/p99 }], uptimeMs, timestamp }
   * 可被外部采集系统（Prometheus scraper / 内部 dashboard）轮询。
   */
  route('GET', '/metrics', (_req, res) => {
    json(res, metrics.snapshot());
  });

  return function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const method = req.method ?? 'GET';

    setCorsHeaders(res, req);
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

function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  const origin = req?.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3889');
  }
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
