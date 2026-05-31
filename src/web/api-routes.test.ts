import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';
import type { WebServerDependencies } from './types.js';

// ---------------------------------------------------------------------------
// Helpers: in-memory SQLite with core schema
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers: mock Node http objects
// ---------------------------------------------------------------------------

function mockRequest(
  method: string,
  pathname: string,
  body?: string | null,
  headers?: Record<string, string>,
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = { host: 'localhost:3888', ...headers };
  (req as unknown as { destroy: () => void }).destroy = vi.fn();

  // Deliver body on next tick so the handler can attach listeners first.
  // Use setImmediate to ensure it fires after the handler attaches its own
  // listeners in the same microtask queue flush.
  if (body !== undefined && body !== null) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }

  return req;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
}

function mockResponse(): { res: ServerResponse; captured: CapturedResponse; endPromise: Promise<void> } {
  let resolveEnd: () => void;
  const endPromise = new Promise<void>((r) => { resolveEnd = r; });

  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
  };

  const res = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      captured.statusCode = statusCode;
      if (headers) Object.assign(captured.headers, headers);
    },
    setHeader(name: string, value: string | string[]) {
      captured.headers[name] = value;
    },
    end(data?: string | Buffer) {
      captured.body = typeof data === 'string' ? data : data?.toString() ?? '';
      captured.ended = true;
      resolveEnd();
    },
    headersSent: false,
  } as unknown as ServerResponse;

  return { res, captured, endPromise };
}

function parseBody<T = unknown>(captured: CapturedResponse): T {
  return JSON.parse(captured.body) as T;
}

// ---------------------------------------------------------------------------
// Helpers: stub WebServerDependencies
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<WebServerDependencies>): WebServerDependencies {
  return {
    taskManager: {
      getTask: vi.fn().mockReturnValue(undefined),
      cancel: vi.fn(),
      create: vi.fn().mockReturnValue('tsk_test'),
    } as unknown as WebServerDependencies['taskManager'],
    sessionManager: {} as WebServerDependencies['sessionManager'],
    agentManager: {
      getStatus: vi.fn().mockReturnValue({ brain: { status: 'running', pid: 1234, uptime: 42 } }),
    } as unknown as WebServerDependencies['agentManager'],
    agentLifecycle: {
      list: vi.fn().mockReturnValue([]),
      inspect: vi.fn().mockReturnValue(null),
      enable: vi.fn(),
      disable: vi.fn(),
    } as unknown as WebServerDependencies['agentLifecycle'],
    eventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    } as unknown as WebServerDependencies['eventBus'],
    config: {} as WebServerDependencies['config'],
    configService: (() => {
      let stored: Record<string, unknown> = { web: { port: 3888 }, observability: { level: 'info' } };
      return {
        get: vi.fn().mockImplementation(() => stored),
        getSection: vi.fn(),
        updateSection: vi.fn().mockImplementation((partial: Record<string, unknown>) => {
          const knownKeys = new Set(['llm', 'web', 'observability', 'memory', 'skills', 'budget', 'cron', 'mcp', 'daemon', 'autonomy', 'plugins', 'channels', 'streaming', 'toolLoop', 'permissionMode', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'requestTimeoutMs']);
          const filtered = Object.keys(partial).filter(k => knownKeys.has(k));
          if (filtered.length === 0) return { ok: false, error: 'No valid config keys provided' };
          stored = { ...stored, ...partial };
          return { ok: true };
        }),
        reload: vi.fn(),
        dispose: vi.fn(),
        onChange: vi.fn().mockReturnValue(() => {}),
        getConfigPath: vi.fn().mockReturnValue('/tmp/test-config.yaml'),
        getAppHome: vi.fn().mockReturnValue('/tmp/test-home'),
      } as unknown as WebServerDependencies['configService'];
    })(),
    permissionCoordinator: {} as WebServerDependencies['permissionCoordinator'],
    handleMessage: vi.fn(),
    handleInterrupt: vi.fn(),
    startTimeMs: Date.now() - 60_000,
    secret: '',
    schedulerService: null,
    notificationService: null,
    memoryLayerService: null,
    workspaceContextService: null,
    pluginScopeService: null,
    templateService: null,
    asyncDelegationService: null,
    teamBuilderService: null,
    humanDelegationManager: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared state for DB mock
// ---------------------------------------------------------------------------

let activeDb: Database.Database | null = null;

// Mock the memory module so getDb() returns our test DB
vi.mock('../memory/index.js', () => ({
  getDb: () => {
    if (!activeDb) throw new Error('Test DB not initialized');
    return activeDb;
  },
  initDb: vi.fn(),
  closeDb: vi.fn(),
  MemoryRuntime: vi.fn(),
}));

// Mock memory/conversations.js so getHistory uses our mock DB
vi.mock('../memory/conversations.js', () => ({
  getHistory: (sessionId: string, limit = 20) => {
    if (!activeDb) throw new Error('Test DB not initialized');
    const rows = activeDb.prepare(
      `SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as 'user' | 'assistant',
      content: row.content as string,
      createdAt: row.created_at as number,
    }));
  },
  saveMessage: vi.fn(),
}));

// Mock scheduler/intelligence route registrations — they just register routes
// with null services returning 503; we don't need to test them here.
vi.mock('../scheduler/api-handlers.js', () => ({
  registerSchedulerRoutes: vi.fn(),
}));
vi.mock('../intelligence/notification-api.js', () => ({
  registerNotificationRoutes: vi.fn(),
}));
vi.mock('../intelligence/memory-api.js', () => ({
  registerMemoryRoutes: vi.fn(),
}));
vi.mock('../intelligence/workspace-context-api.js', () => ({
  registerWorkspaceContextRoutes: vi.fn(),
}));
vi.mock('../intelligence/plugin-scope-api.js', () => ({
  registerPluginScopeRoutes: vi.fn(),
}));
vi.mock('../intelligence/template-api.js', () => ({
  registerTemplateRoutes: vi.fn(),
}));
vi.mock('../intelligence/async-delegation-api.js', () => ({
  registerAsyncDelegationRoutes: vi.fn(),
}));
vi.mock('../intelligence/team-builder-api.js', () => ({
  registerTeamBuilderRoutes: vi.fn(),
}));

// Import AFTER vi.mock so it gets the mocked versions
import { createApiRouter } from './api-routes.js';

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setupDb(): Database.Database {
  activeDb = createTestDb();
  return activeDb;
}

function teardownDb(): void {
  if (activeDb) {
    activeDb.close();
    activeDb = null;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createApiRouter', () => {
  let db: Database.Database;
  let deps: WebServerDependencies;
  let handleApi: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    db = setupDb();
    deps = createMockDeps();
    handleApi = createApiRouter(deps);
  });

  afterEach(() => {
    teardownDb();
  });

  // Sync dispatch — for routes that do NOT read body (GET, DELETE, POST with no body)
  function dispatchSync(
    method: string,
    pathname: string,
    headers?: Record<string, string>,
  ): CapturedResponse {
    const req = mockRequest(method, pathname, null, headers);
    const { res, captured } = mockResponse();
    const url = new URL(pathname, 'http://localhost:3888');
    handleApi(req, res, url);
    return captured;
  }

  // Async dispatch — for routes that read body via readBody()
  async function dispatch(
    method: string,
    pathname: string,
    body: string,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse> {
    const req = mockRequest(method, pathname, body, headers);
    const { res, captured, endPromise } = mockResponse();
    const url = new URL(pathname, 'http://localhost:3888');
    handleApi(req, res, url);
    await endPromise;
    return captured;
  }

  // -----------------------------------------------------------------------
  // 1. GET /api/health
  // -----------------------------------------------------------------------
  describe('GET /api/health', () => {
    it('returns ok with uptime info', () => {
      const captured = dispatchSync('GET', '/api/health');
      const data = parseBody<{ ok: boolean; uptime: number; agents: number }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.agents).toBe(1);
      expect(captured.headers['content-type']).toContain('application/json');
    });
  });

  // -----------------------------------------------------------------------
  // 2. GET /api/config
  // -----------------------------------------------------------------------
  describe('GET /api/config', () => {
    it('returns config object', () => {
      const captured = dispatchSync('GET', '/api/config');
      const data = parseBody<Record<string, unknown>>(captured);

      expect(captured.statusCode).toBe(200);
      // Returns whatever config is on disk (may be non-empty if a prior
      // PUT test in the same suite wrote to it)
      expect(typeof data).toBe('object');
      expect(data).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 3. PUT /api/config
  // -----------------------------------------------------------------------
  describe('PUT /api/config', () => {
    it('rejects non-object body', async () => {
      const captured = await dispatch('PUT', '/api/config', '"not-an-object"');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('rejects empty object', async () => {
      const captured = await dispatch('PUT', '/api/config', '{}');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(400);
      expect(data.error).toContain('No valid config keys');
    });

    it('rejects unknown top-level keys', async () => {
      const captured = await dispatch('PUT', '/api/config', '{"totallyBogus":true}');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(400);
      expect(data.error).toContain('No valid config keys');
    });

    it('accepts valid config keys and returns ok', async () => {
      const captured = await dispatch('PUT', '/api/config', '{"observability":{"level":"debug"}}');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);

      // Verify it was written by reading it back via GET
      const getCaptured = dispatchSync('GET', '/api/config');
      const getConfig = parseBody<Record<string, unknown>>(getCaptured);
      expect(getConfig.observability).toEqual({ level: 'debug' });
    });
  });

  // -----------------------------------------------------------------------
  // 4. GET /api/config/defaults
  // -----------------------------------------------------------------------
  describe('GET /api/config/defaults', () => {
    it('returns default config structure', () => {
      const captured = dispatchSync('GET', '/api/config/defaults');
      const data = parseBody<Record<string, unknown>>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.llm).toBeDefined();
      expect(data.budget).toBeDefined();
      expect(data.memory).toBeDefined();
      expect(data.skills).toBeDefined();
      expect(data.observability).toBeDefined();
      expect(data.web).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5. GET /api/tasks
  // -----------------------------------------------------------------------
  describe('GET /api/tasks', () => {
    it('returns empty items when no tasks', () => {
      const captured = dispatchSync('GET', '/api/tasks');
      const data = parseBody<{ items: unknown[]; total: number }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('returns tasks with pagination', () => {
      const stmt = db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 5; i++) {
        stmt.run(`tsk_${i}`, `ses_${i}`, `cor_${i}`, 'test', 'user', 'brain', '{}', 'created', Date.now() - i * 1000);
      }

      const captured = dispatchSync('GET', '/api/tasks');
      const data = parseBody<{ items: unknown[]; total: number }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.total).toBe(5);
      expect(data.items).toHaveLength(5);
    });

    it('supports limit parameter', () => {
      const stmt = db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 10; i++) {
        stmt.run(`tsk_${i}`, `ses_${i}`, `cor_${i}`, 'test', 'user', 'brain', '{}', 'created', Date.now());
      }

      const captured = dispatchSync('GET', '/api/tasks?limit=3');
      const data = parseBody<{ items: unknown[]; total: number }>(captured);

      expect(data.total).toBe(10);
      expect(data.items).toHaveLength(3);
    });

    it('supports status filter', () => {
      const stmt = db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('tsk_1', 'ses_1', 'cor_1', 'test', 'user', 'brain', '{}', 'completed', Date.now());
      stmt.run('tsk_2', 'ses_2', 'cor_2', 'test', 'user', 'brain', '{}', 'failed', Date.now());

      const captured = dispatchSync('GET', '/api/tasks?status=completed');
      const data = parseBody<{ items: unknown[]; total: number }>(captured);

      expect(data.total).toBe(1);
    });

    it('supports agent filter', () => {
      const stmt = db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('tsk_1', 'ses_1', 'cor_1', 'test', 'user', 'brain', '{}', 'created', Date.now());
      stmt.run('tsk_2', 'ses_2', 'cor_2', 'test', 'user', 'code', '{}', 'created', Date.now());

      const captured = dispatchSync('GET', '/api/tasks?agent=brain');
      const data = parseBody<{ items: unknown[]; total: number }>(captured);

      expect(data.total).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 6. GET /api/tasks/:id
  // -----------------------------------------------------------------------
  describe('GET /api/tasks/:id', () => {
    it('returns 404 when task not found', () => {
      const captured = dispatchSync('GET', '/api/tasks/tsk_nonexistent');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(404);
      expect(data.error).toBe('Not Found');
    });

    it('returns task when found', () => {
      const taskRow = {
        id: 'tsk_1', status: 'created', target_agent: 'brain',
      };
      (deps.taskManager.getTask as ReturnType<typeof vi.fn>).mockReturnValue(taskRow);

      const captured = dispatchSync('GET', '/api/tasks/tsk_1');
      const data = parseBody<Record<string, unknown>>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.id).toBe('tsk_1');
      expect(data.targetAgent).toBe('brain');
    });
  });

  // -----------------------------------------------------------------------
  // 7. POST /api/tasks/:id/cancel
  // -----------------------------------------------------------------------
  describe('POST /api/tasks/:id/cancel', () => {
    it('cancels task with default reason', async () => {
      const captured = await dispatch('POST', '/api/tasks/tsk_1/cancel', '{}');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);
      expect(deps.taskManager.cancel).toHaveBeenCalledWith('tsk_1', 'Cancelled via web dashboard');
    });

    it('cancels task with custom reason', async () => {
      const captured = await dispatch('POST', '/api/tasks/tsk_1/cancel', '{"reason":"user abort"}');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);
      expect(deps.taskManager.cancel).toHaveBeenCalledWith('tsk_1', 'user abort');
    });
  });

  // -----------------------------------------------------------------------
  // 8. GET /api/agents
  // -----------------------------------------------------------------------
  describe('GET /api/agents', () => {
    it('returns list of agents', () => {
      (deps.agentLifecycle.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: 'brain', status: 'enabled', version: '1.0.0' },
      ]);

      const captured = dispatchSync('GET', '/api/agents');
      const data = parseBody<Record<string, unknown>[]>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('brain');
    });
  });

  // -----------------------------------------------------------------------
  // 9. GET /api/agents/:name
  // -----------------------------------------------------------------------
  describe('GET /api/agents/:name', () => {
    it('returns 404 for unknown agent', () => {
      (deps.agentLifecycle.inspect as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const captured = dispatchSync('GET', '/api/agents/nonexistent');
      expect(captured.statusCode).toBe(404);
    });

    it('returns agent info', () => {
      (deps.agentLifecycle.inspect as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'brain',
        agent_dir: '/agents/brain',
        task_count: 5,
      });

      const captured = dispatchSync('GET', '/api/agents/brain');
      const data = parseBody<Record<string, unknown>>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.name).toBe('brain');
      expect(data.agentDir).toBe('/agents/brain');
      expect(data.taskCount).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // 10. POST /api/agents/:name/enable & disable
  // -----------------------------------------------------------------------
  describe('POST /api/agents/:name/enable', () => {
    it('enables agent', () => {
      const captured = dispatchSync('POST', '/api/agents/brain/enable');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);
      expect(deps.agentLifecycle.enable).toHaveBeenCalledWith('brain');
    });
  });

  describe('POST /api/agents/:name/disable', () => {
    it('disables agent with reason', async () => {
      const captured = await dispatch('POST', '/api/agents/brain/disable', '{"reason":"maintenance"}');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);
      expect(deps.agentLifecycle.disable).toHaveBeenCalledWith('brain', 'maintenance');
    });
  });

  // -----------------------------------------------------------------------
  // 11. GET /api/conversations
  // -----------------------------------------------------------------------
  describe('GET /api/conversations', () => {
    it('returns empty list when no conversations', () => {
      const captured = dispatchSync('GET', '/api/conversations');
      const data = parseBody<unknown[]>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns conversations', () => {
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_1', 'ses_abc', 'user', 'hello', Date.now());

      const captured = dispatchSync('GET', '/api/conversations');
      const data = parseBody<Record<string, unknown>[]>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].sessionId).toBe('ses_abc');
    });
  });

  // -----------------------------------------------------------------------
  // 12. GET /api/conversations/:sid
  // -----------------------------------------------------------------------
  describe('GET /api/conversations/:sid', () => {
    it('returns messages for a session', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_1', 'ses_abc', 'user', 'hello', now);
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_2', 'ses_abc', 'assistant', 'hi there', now + 100);

      const captured = dispatchSync('GET', '/api/conversations/ses_abc');
      const data = parseBody<Record<string, unknown>[]>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data).toHaveLength(2);
      expect(data[0].content).toBe('hello');
      expect(data[1].content).toBe('hi there');
    });
  });

  // -----------------------------------------------------------------------
  // 13. DELETE /api/conversations/:sid
  // -----------------------------------------------------------------------
  describe('DELETE /api/conversations/:sid', () => {
    it('deletes conversation and meta', () => {
      const sid = 'ses_delete_test';
      const now = Date.now();
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_1', sid, 'user', 'to be deleted', now);
      db.prepare(`
        INSERT INTO conversation_meta (session_id, title, updated_at)
        VALUES (?, ?, ?)
      `).run(sid, 'test title', now);

      const beforeConvs = db.prepare('SELECT COUNT(*) as cnt FROM conversations WHERE session_id = ?').get(sid) as { cnt: number };
      expect(beforeConvs.cnt).toBe(1);

      const captured = dispatchSync('DELETE', `/api/conversations/${sid}`);
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);

      const afterConvs = db.prepare('SELECT COUNT(*) as cnt FROM conversations WHERE session_id = ?').get(sid) as { cnt: number };
      expect(afterConvs.cnt).toBe(0);
      const afterMeta = db.prepare('SELECT COUNT(*) as cnt FROM conversation_meta WHERE session_id = ?').get(sid) as { cnt: number };
      expect(afterMeta.cnt).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 14. PUT /api/conversations/:sid (rename)
  // -----------------------------------------------------------------------
  describe('PUT /api/conversations/:sid', () => {
    it('requires title field', async () => {
      const captured = await dispatch('PUT', '/api/conversations/ses_1', '{}');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(400);
      expect(data.error).toContain('title is required');
    });

    it('sets conversation title', async () => {
      const captured = await dispatch('PUT', '/api/conversations/ses_1', '{"title":"My Chat"}');
      const data = parseBody<{ ok: boolean }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.ok).toBe(true);

      const row = db.prepare('SELECT title FROM conversation_meta WHERE session_id = ?').get('ses_1') as { title: string } | undefined;
      expect(row?.title).toBe('My Chat');
    });

    it('updates existing title (upsert)', async () => {
      db.prepare('INSERT INTO conversation_meta (session_id, title, updated_at) VALUES (?, ?, ?)').run('ses_1', 'Old', 1000);

      await dispatch('PUT', '/api/conversations/ses_1', '{"title":"New"}');

      const row = db.prepare('SELECT title FROM conversation_meta WHERE session_id = ?').get('ses_1') as { title: string } | undefined;
      expect(row?.title).toBe('New');
    });
  });

  // -----------------------------------------------------------------------
  // 15. GET /api/search
  // -----------------------------------------------------------------------
  describe('GET /api/search', () => {
    it('returns empty results when no query', () => {
      const captured = dispatchSync('GET', '/api/search');
      const data = parseBody<{ results: unknown[]; total: number }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.results).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('returns matching results', () => {
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_1', 'ses_1', 'user', 'I love TypeScript', Date.now());
      db.prepare(`
        INSERT INTO conversations (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg_2', 'ses_1', 'assistant', 'Python is also nice', Date.now());

      const captured = dispatchSync('GET', '/api/search?q=TypeScript');
      const data = parseBody<{ results: Record<string, unknown>[]; total: number }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.total).toBe(1);
      expect(data.results[0].content).toBe('I love TypeScript');
      expect(data.results[0].highlight).toContain('TypeScript');
    });
  });

  // -----------------------------------------------------------------------
  // 16. GET /api/tasks/stats
  // /tasks/stats is registered BEFORE /tasks/:id to avoid route shadowing.
  // -----------------------------------------------------------------------
  describe('GET /api/tasks/stats', () => {
    it('returns daily stats', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('tsk_1', 'ses_1', 'cor_1', 'test', 'user', 'brain', '{}', 'completed', now);
      db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('tsk_2', 'ses_2', 'cor_2', 'test', 'user', 'brain', '{}', 'failed', now);

      const captured = dispatchSync('GET', '/api/tasks/stats');
      expect(captured.statusCode).toBe(200);
      const data = parseBody<{ date: string; completed: number; failed: number }[]>(captured);
      expect(Array.isArray(data)).toBe(true);
      // Should have at least today's entry
      const today = data.find(d => d.completed === 1 && d.failed === 1);
      expect(today).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 17. CORS headers
  // -----------------------------------------------------------------------
  describe('CORS', () => {
    it('sets CORS headers on all responses', () => {
      const captured = dispatchSync('GET', '/api/health');

      expect(captured.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(captured.headers['Access-Control-Allow-Methods']).toContain('GET');
      expect(captured.headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(captured.headers['Access-Control-Allow-Headers']).toContain('Content-Type');
    });

    it('handles OPTIONS preflight with 204', () => {
      const captured = dispatchSync('OPTIONS', '/api/health');

      expect(captured.statusCode).toBe(204);
    });
  });

  // -----------------------------------------------------------------------
  // 18. 404 for unknown routes
  // -----------------------------------------------------------------------
  describe('unknown routes', () => {
    it('returns 404 for unknown API paths', () => {
      const captured = dispatchSync('GET', '/api/nonexistent');
      const data = parseBody<{ error: string }>(captured);

      expect(captured.statusCode).toBe(404);
      expect(data.error).toBe('Not Found');
    });
  });

  // -----------------------------------------------------------------------
  // 19. Method mismatch returns 404
  // -----------------------------------------------------------------------
  describe('method mismatch', () => {
    it('returns 404 when method does not match', () => {
      const captured = dispatchSync('DELETE', '/api/health');
      expect(captured.statusCode).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // 20. GET /api/usage/summary
  // -----------------------------------------------------------------------
  describe('GET /api/usage/summary', () => {
    it('returns usage summary with zero values when no data', () => {
      const captured = dispatchSync('GET', '/api/usage/summary?days=7');
      const data = parseBody<Record<string, unknown>>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.today).toBeDefined();
      expect(data.period).toBeDefined();
      expect(data.daily).toBeDefined();
      expect(data.byAgent).toBeDefined();
      expect(data.byModel).toBeDefined();
    });

    it('returns aggregated usage data', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO token_usage (session_id, agent_name, input_tokens, output_tokens, model, cost_usd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ses_1', 'brain', 1000, 500, 'claude-sonnet', 0.01, now);

      const captured = dispatchSync('GET', '/api/usage/summary?days=1');
      const data = parseBody<{
        today: Record<string, number>;
        period: Record<string, number>;
        daily: Record<string, unknown>[];
        byAgent: Record<string, unknown>[];
        byModel: Record<string, unknown>[];
      }>(captured);

      expect(captured.statusCode).toBe(200);
      expect(data.today.inputTokens).toBe(1000);
      expect(data.today.outputTokens).toBe(500);
      expect(data.byAgent).toHaveLength(1);
      expect(data.byAgent[0].agentName).toBe('brain');
      expect(data.byModel).toHaveLength(1);
      expect(data.byModel[0].model).toBe('claude-sonnet');
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for safeInt helper (via route behavior)
// ---------------------------------------------------------------------------

describe('safeInt via route parameter handling', () => {
  let db: Database.Database;
  let deps: WebServerDependencies;
  let handleApi: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    db = setupDb();
    deps = createMockDeps();
    handleApi = createApiRouter(deps);
  });

  afterEach(() => {
    teardownDb();
  });

  function dispatchSync(method: string, pathname: string): CapturedResponse {
    const req = mockRequest(method, pathname, null);
    const { res, captured } = mockResponse();
    const url = new URL(pathname, 'http://localhost:3888');
    handleApi(req, res, url);
    return captured;
  }

  it('clamps limit to max (200 for tasks)', () => {
    const stmt = db.prepare(`
      INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 3; i++) {
      stmt.run(`tsk_${i}`, `ses_${i}`, `cor_${i}`, 'test', 'user', 'brain', '{}', 'created', Date.now());
    }

    // limit=999 should be clamped to max 200, still returns all 3
    const captured = dispatchSync('GET', '/api/tasks?limit=999');
    const data = parseBody<{ items: unknown[]; total: number }>(captured);
    expect(data.items).toHaveLength(3);
  });

  it('uses fallback when limit is not a number', () => {
    const captured = dispatchSync('GET', '/api/tasks?limit=abc');
    expect(captured.statusCode).toBe(200);
  });

  it('clamps negative offset to 0', () => {
    const captured = dispatchSync('GET', '/api/tasks?offset=-5');
    expect(captured.statusCode).toBe(200);
  });

  it('clamps limit to min (1 for tasks)', () => {
    const stmt = db.prepare(`
      INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 5; i++) {
      stmt.run(`tsk_${i}`, `ses_${i}`, `cor_${i}`, 'test', 'user', 'brain', '{}', 'created', Date.now());
    }

    const captured = dispatchSync('GET', '/api/tasks?limit=0');
    const data = parseBody<{ items: unknown[]; total: number }>(captured);
    // limit=0 -> clamped to min=1
    expect(data.items).toHaveLength(1);
  });

  it('handles null/missing parameters with defaults', () => {
    const captured = dispatchSync('GET', '/api/tasks');
    expect(captured.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Input validation edge cases
// ---------------------------------------------------------------------------

describe('input validation edge cases', () => {
  let db: Database.Database;
  let deps: WebServerDependencies;
  let handleApi: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    db = setupDb();
    deps = createMockDeps();
    handleApi = createApiRouter(deps);
  });

  afterEach(() => {
    teardownDb();
  });

  async function dispatch(
    method: string,
    pathname: string,
    body: string,
  ): Promise<CapturedResponse> {
    const req = mockRequest(method, pathname, body);
    const { res, captured, endPromise } = mockResponse();
    const url = new URL(pathname, 'http://localhost:3888');
    handleApi(req, res, url);
    await endPromise;
    return captured;
  }

  it('PUT /api/config with array body is rejected', async () => {
    const captured = await dispatch('PUT', '/api/config', '[1,2,3]');
    const data = parseBody<{ error: string }>(captured);
    expect(captured.statusCode).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('PUT /api/config with string body is rejected', async () => {
    const captured = await dispatch('PUT', '/api/config', '"hello"');
    const data = parseBody<{ error: string }>(captured);
    expect(captured.statusCode).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('PUT /api/conversations/:sid with whitespace-only title is rejected', async () => {
    const captured = await dispatch('PUT', '/api/conversations/ses_1', '{"title":"   "}');
    const data = parseBody<{ error: string }>(captured);
    expect(captured.statusCode).toBe(400);
    expect(data.error).toContain('title is required');
  });

  it('PUT /api/conversations/:sid with non-string title is rejected', async () => {
    const captured = await dispatch('PUT', '/api/conversations/ses_1', '{"title":123}');
    const data = parseBody<{ error: string }>(captured);
    expect(captured.statusCode).toBe(400);
    expect(data.error).toContain('title is required');
  });

  it('GET /api/search with whitespace-only query returns empty results', () => {
    const req = mockRequest('GET', '/api/search?q=%20%20', null);
    const { res, captured } = mockResponse();
    const url = new URL('/api/search?q=%20%20', 'http://localhost:3888');
    handleApi(req, res, url);
    const data = parseBody<{ results: unknown[]; total: number }>(captured);

    expect(captured.statusCode).toBe(200);
    expect(data.total).toBe(0);
  });
});
