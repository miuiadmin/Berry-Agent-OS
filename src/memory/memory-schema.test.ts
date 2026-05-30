import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMemoryContext } from './context-builder.js';
import { closeDb, initDb } from './db.js';
import { addKnowledge, getKnowledge, promoteKnowledge } from './knowledge.js';
import { MemoryRuntime } from './runtime.js';
import { CORE_SCHEMA_SQL } from './schema.js';
import { searchKnowledge } from './search.js';
import { buildSystemPrompt } from '../llm/prompt-builder.js';
import { EVIDENCE_KINDS, KNOWLEDGE_SOURCES, KNOWLEDGE_TYPES, RECALL_SOURCES } from '../contracts/memory.js';

let tempDirs: string[] = [];

afterEach(() => {
  closeDb();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('memory schema', () => {
  it('creates the complete core schema declared by the architecture document', () => {
    const db = initDb(makeDbPath());
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table','virtual') AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => (row as { name: string }).name);

    expect(tables).toEqual(expect.arrayContaining([
      'modules_meta',
      'agent_homes',
      'conversations',
      'agent_tasks',
      'agent_task_workspaces',
      'agent_messages',
      'task_events',
      'review_requests',
      'model_requests',
      'tool_calls',
      'approval_requests',
      'permission_tokens',
      'code_task_artifacts',
      'run_artifacts',
      'console_frames',
      'log_events',
      'sdk_event_index',
      'workspaces',
      'workspace_capabilities',
      'knowledge',
      'memory_access_log',
      'episodes',
      'skills_meta',
      'plugins_meta',
      'plugin_tools',
      'plugin_events',
      'evolution_proposals',
      'scheduled_tasks',
      'token_usage',
      'config',
      'knowledge_fts',
    ]));
  });

  it('enforces checks on newly aligned schema tables', () => {
    const db = initDb(makeDbPath());

    expect(() => db.prepare(`
      INSERT INTO review_requests (id, session_id, level, draft_response, review_input, verdict)
      VALUES ('rev_bad', 's1', 'D', 'draft', '{}', 'approve')
    `).run()).toThrow();

    expect(() => db.prepare(`
      INSERT INTO tool_calls (id, session_id, agent_name, tool_name, input, input_hash, permission_verdict)
      VALUES ('tc_bad', 's1', 'conversation', 'read_file', '{}', 'hash', 'maybe')
    `).run()).toThrow();

    expect(() => db.prepare(`
      INSERT INTO console_frames (id, run_id, seq, stream, source)
      VALUES ('cf_bad', NULL, 1, 'trace', 'test')
    `).run()).toThrow();
  });

  it('migrates old operational tables to the architecture schema', () => {
    const dbPath = makeDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO conversations (id, session_id, role, content, created_at)
      VALUES ('msg_1', 's1', 'assistant', '旧会话', 10);

      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        draft_response TEXT NOT NULL,
        level TEXT NOT NULL,
        verdict TEXT NOT NULL,
        final_response TEXT,
        reason TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO reviews (
        id, session_id, user_message, draft_response, level, verdict, final_response, reason, created_at
      ) VALUES ('rev_1', 's1', '你好', '草稿', 'B', 'approve', '最终', 'ok', 20);

      CREATE TABLE token_usage (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO token_usage (id, agent, model, input_tokens, output_tokens, created_at)
      VALUES ('tok_1', 'conversation', 'test-model', 1, 2, 30);

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_result TEXT,
        is_error INTEGER DEFAULT 0,
        permission_mode TEXT,
        danger_level TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO tool_calls (
        id, session_id, tool_name, tool_input, tool_result, is_error, permission_mode, danger_level, duration_ms, created_at
      ) VALUES ('tc_1', 's1', 'read_file', '{"path":"a"}', '{"ok":true}', 0, 'allow-all', 'safe', 5, 40);

      CREATE TABLE run_artifacts (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        exit_code INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO run_artifacts (id, command, artifact_dir, started_at, finished_at, exit_code, created_at)
      VALUES ('run_1', 'npm test', '/tmp/run', 50, 60, 0, 50);

      CREATE TABLE log_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        level TEXT NOT NULL,
        module TEXT NOT NULL,
        msg TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO log_events (run_id, level, module, msg, data, created_at)
      VALUES ('run_1', 'info', 'test', '旧日志', '{"a":1}', 70);

      CREATE TABLE console_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO console_frames (run_id, stream, text, created_at)
      VALUES ('run_1', 'stdout', '旧输出', 80);
    `);
    legacy.close();

    const db = initDb(dbPath);

    expect(tableColumns(db, 'conversations')).toEqual(expect.arrayContaining([
      'tool_name',
      'tool_input',
      'tool_result',
      'token_count',
    ]));
    expect(tableColumns(db, 'review_requests')).toContain('review_input');
    expect(tableExists(db, 'reviews')).toBe(false);

    const review = db.prepare(`SELECT level, review_input, verdict FROM review_requests WHERE id = 'rev_1'`)
      .get() as { level: string; review_input: string; verdict: string };
    expect(review.level).toBe('B');
    expect(JSON.parse(review.review_input)).toEqual({ user_message: '你好' });
    expect(review.verdict).toBe('approve');

    const toolColumns = tableColumns(db, 'tool_calls');
    expect(toolColumns).toEqual(expect.arrayContaining(['input', 'input_hash', 'permission_verdict', 'started_at', 'finished_at']));
    expect(toolColumns).not.toContain('tool_input');
    const toolCall = db.prepare(`SELECT input, input_hash, permission_verdict FROM tool_calls WHERE id = 'tc_1'`)
      .get() as { input: string; input_hash: string; permission_verdict: string };
    expect(toolCall).toEqual({ input: '{"path":"a"}', input_hash: '', permission_verdict: 'allow' });

    const tokenColumns = tableColumns(db, 'token_usage');
    expect(tokenColumns).toEqual(expect.arrayContaining(['session_id', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd']));
    expect(tokenColumns).not.toContain('agent');

    const runColumns = tableColumns(db, 'run_artifacts');
    expect(runColumns).toEqual(expect.arrayContaining(['kind', 'log_level', 'status']));
    expect(runColumns).not.toContain('exit_code');
    expect((db.prepare(`SELECT status FROM run_artifacts WHERE id = 'run_1'`).get() as { status: string }).status).toBe('passed');

    const logColumns = tableColumns(db, 'log_events');
    expect(logColumns).toEqual(expect.arrayContaining(['message', 'payload', 'correlation_id', 'span_id']));
    expect(logColumns).not.toContain('msg');

    const frameColumns = tableColumns(db, 'console_frames');
    expect(frameColumns).toEqual(expect.arrayContaining(['seq', 'source', 'level', 'is_json', 'payload']));
    const frame = db.prepare(`SELECT seq, source, stream, text FROM console_frames`).get() as {
      seq: number;
      source: string;
      stream: string;
      text: string;
    };
    expect(frame).toEqual({ seq: 1, source: 'cli', stream: 'stdout', text: '旧输出' });
  });

  it('migrates legacy memory tables without keeping ambiguous source fields', () => {
    const dbPath = makeDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN (
          'identity','preference','goal','project','habit',
          'decision','constraint','relationship','fact','reflection'
        )),
        summary TEXT NOT NULL,
        detail TEXT,
        scope TEXT NOT NULL DEFAULT 'active' CHECK(scope IN ('active','durable')),
        evidence_kind TEXT NOT NULL DEFAULT 'inferred'
          CHECK(evidence_kind IN ('direct','inferred','manual')),
        source TEXT NOT NULL DEFAULT 'conversation',
        confidence REAL NOT NULL DEFAULT 0.7,
        importance REAL NOT NULL DEFAULT 0.5,
        durability REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        provenance TEXT,
        dismissed INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER
      );

      INSERT INTO knowledge (
        id, type, summary, detail, scope, evidence_kind, source,
        confidence, importance, durability, evidence_count, provenance,
        dismissed, superseded_by, created_at, updated_at, last_accessed_at
      ) VALUES (
        'kn_legacy', 'fact', '旧库迁移测试记忆', NULL, 'active', 'direct', 'bad_source',
        0.9, 0.7, 0.8, 2, 'session:legacy',
        0, NULL, 1, 2, 3
      );

      CREATE TABLE memory_access_log (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT 'conversation',
        source TEXT NOT NULL CHECK(source IN ('auto_recall','tool_query','brain_requested')),
        query TEXT NOT NULL,
        result_ids TEXT NOT NULL DEFAULT '[]',
        scores TEXT,
        context_chars INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO memory_access_log (id, session_id, source, query)
      VALUES ('mal_legacy', 's1', 'tool_query', '旧查询');
    `);
    legacy.close();

    const db = initDb(dbPath);
    const accessColumns = tableColumns(db, 'memory_access_log');
    expect(accessColumns).not.toContain('source');
    expect(accessColumns).toContain('recall_source');

    const migratedAccess = db.prepare(
      `SELECT recall_source FROM memory_access_log WHERE id = 'mal_legacy'`,
    ).get() as { recall_source: string };
    expect(migratedAccess.recall_source).toBe('tool_query');

    const migratedKnowledge = getKnowledge('kn_legacy');
    expect(migratedKnowledge?.source).toBe('conversation');
    expect(migratedKnowledge?.lastSeenAt).toBe(2);

    const systemEntry = addKnowledge({
      type: 'reflection',
      summary: '系统整理出的长期偏好模式',
      evidenceKind: 'system',
      source: 'system',
    });
    expect(systemEntry.evidenceKind).toBe('system');
    expect(systemEntry.source).toBe('system');

    const frame = buildMemoryContext('s1', '旧库迁移测试记忆', 'auto_recall');
    expect(frame.records.map((record) => record.id)).toContain('kn_legacy');
    const accessCount = db.prepare(
      `SELECT COUNT(*) AS count FROM memory_access_log`,
    ).get() as { count: number };
    expect(accessCount.count).toBe(2);
  });

  it('records recall audit and last-used fields separately from evidence reinforcement', () => {
    const db = initDb(makeDbPath());
    const entry = addKnowledge({
      type: 'preference',
      summary: '用户偏好中文控制台输出',
      evidenceKind: 'direct',
      source: 'conversation',
      provenance: 'session:test',
    });

    const results = searchKnowledge('中文 控制台', { limit: 1 });
    expect(results[0]?.id).toBe(entry.id);

    const usedRow = db.prepare(
      `SELECT last_seen_at, last_used_at, last_used_query FROM knowledge WHERE id = ?`,
    ).get(entry.id) as { last_seen_at: number; last_used_at: number; last_used_query: string };
    expect(usedRow.last_seen_at).toBeGreaterThan(0);
    expect(usedRow.last_used_at).toBeGreaterThan(0);
    expect(usedRow.last_used_query).toBe('中文 控制台');

    const frame = buildMemoryContext('s-recall', '控制台输出', 'brain_requested', { runId: 'run-1' });
    expect(frame.recallSource).toBe('brain_requested');

    const access = db.prepare(
      `SELECT recall_source, query FROM memory_access_log WHERE session_id = 's-recall'`,
    ).get() as { recall_source: string; query: string };
    expect(access).toEqual({ recall_source: 'brain_requested', query: '控制台输出' });
  });

  it('only promotes strongly evidenced direct or manual knowledge to durable scope', () => {
    initDb(makeDbPath());

    const inferred = addKnowledge({ type: 'fact', summary: '推断事实不会直接固化', evidenceKind: 'inferred', confidence: 0.95 });
    addKnowledge({ type: 'fact', summary: '推断事实不会直接固化', evidenceKind: 'inferred', confidence: 0.95 });
    addKnowledge({ type: 'fact', summary: '推断事实不会直接固化', evidenceKind: 'inferred', confidence: 0.95 });

    const direct = addKnowledge({ type: 'fact', summary: '用户直接确认的事实可以固化', evidenceKind: 'direct', confidence: 0.95 });
    addKnowledge({ type: 'fact', summary: '用户直接确认的事实可以固化', evidenceKind: 'direct', confidence: 0.95 });
    addKnowledge({ type: 'fact', summary: '用户直接确认的事实可以固化', evidenceKind: 'direct', confidence: 0.95 });

    promoteKnowledge();

    expect(getKnowledge(inferred.id)?.scope).toBe('active');
    expect(getKnowledge(direct.id)?.scope).toBe('durable');
  });

  it('keeps memory context outside the cached system prompt contract', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('<berry-memory-context>');
    expect(prompt).not.toContain('用户偏好中文控制台输出');
  });

  it('keeps SQL enum constraints aligned with the memory contract', () => {
    for (const value of [...KNOWLEDGE_TYPES, ...EVIDENCE_KINDS, ...KNOWLEDGE_SOURCES, ...RECALL_SOURCES]) {
      expect(CORE_SCHEMA_SQL).toContain(`'${value}'`);
    }
  });

  it('records tool-added memory with tool source and tool provenance', () => {
    initDb(makeDbPath());
    const runtime = new MemoryRuntime({ evolutionEnabled: false, consolidationInterval: 50, maxResults: 5 });
    const entry = runtime.add({
      type: 'preference',
      summary: '用户希望工具保存的记忆标明来源',
      evidence_kind: 'manual',
    });

    expect(entry.source).toBe('tool');
    expect(entry.provenance).toBe('tool:memory_add');
  });

  it('waits for queued memory evolution before shutdown can close the database', async () => {
    let releaseEvolution!: () => void;
    let completed = false;
    vi.doMock('./evolution.js', () => ({
      extractMemories: async () => {
        await new Promise<void>((resolve) => {
          releaseEvolution = resolve;
        });
        completed = true;
      },
      consolidateMemories: async () => {},
    }));

    const runtime = new MemoryRuntime({ evolutionEnabled: true, consolidationInterval: 50, maxResults: 5 });
    runtime.queueEvolution('s-evolution', '请记住真实测试偏好', '已记住');

    const idle = runtime.waitForEvolutionIdle();
    await vi.waitFor(() => expect(releaseEvolution).toBeTypeOf('function'));
    expect(completed).toBe(false);

    releaseEvolution();
    await expect(idle).resolves.toBe(true);
    expect(completed).toBe(true);

    vi.doUnmock('./evolution.js');
  });

  it('returns false when queued memory evolution does not become idle before timeout', async () => {
    vi.doMock('./evolution.js', () => ({
      extractMemories: async () => {
        await new Promise<void>(() => {});
      },
      consolidateMemories: async () => {},
    }));

    const runtime = new MemoryRuntime({ evolutionEnabled: true, consolidationInterval: 50, maxResults: 5 });
    runtime.queueEvolution('s-evolution-timeout', '请记住真实测试偏好', '已记住');

    await expect(runtime.waitForEvolutionIdle(10)).resolves.toBe(false);

    vi.doUnmock('./evolution.js');
  });
});

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'berryagent-memory-test-'));
  tempDirs.push(dir);
  return join(dir, 'berryagent.db');
}

function tableColumns(db: Database.Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((col) => (col as { name: string }).name);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { found: number } | undefined;
  return Boolean(row);
}
