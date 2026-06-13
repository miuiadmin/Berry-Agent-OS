import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from './db.js';

/**
 * 15.0 回归测试：完整 initDb 启动路径（CORE_SCHEMA → CORE_INDEX → migrations → FTS）。
 *
 * 守护一个关键 bug：v17/v18/v19 引用 dialogue_messages/agent_chat_messages 等表，
 * 而这些表由 CORE_INDEX_SQL 创建。修复前 CORE_INDEX 在 migrations 之后执行 → v18 崩溃
 * （FTS 触发器引用不存在的表）、v17/v19 静默跳过大部分 redact 目标。修复：CORE_INDEX 前置。
 * 本测试确保 initDb 完整路径跑通 + v18 FTS 表/触发器建立 + dialogue_messages FTS 可用。
 */
describe('initDb 完整启动路径 (15.0 回归)', () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('initDb 不抛错，v18 FTS 虚表 + 触发器全部建立', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-initdb-'));
    initDb(join(dir, 'test.db'));
    const db = getDb();
    const has = (name: string, type: string) =>
      !!db.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name=?`).get(type, name);
    // v18 三张 FTS 虚表
    expect(has('conversations_fts', 'table')).toBe(true);
    expect(has('dialogue_messages_fts', 'table')).toBe(true); // 修复前因 CORE_INDEX 后置而崩溃
    expect(has('agent_chat_messages_fts', 'table')).toBe(true);
    // v18 补齐的 conversations_fts_update 触发器 + dialogue 全套触发器
    expect(has('conversations_fts_update', 'trigger')).toBe(true);
    expect(has('dialogue_messages_fts_insert', 'trigger')).toBe(true);
    expect(has('dialogue_messages_fts_delete', 'trigger')).toBe(true);
    expect(has('dialogue_messages_fts_update', 'trigger')).toBe(true);
  });

  it('dialogue_messages FTS 端到端可用（修复前的崩溃点）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-initdb-'));
    initDb(join(dir, 'test.db'));
    const db = getDb();
    // dialogue_messages 在 CORE_INDEX_SQL 创建；v18 触发器引用它（修复前崩溃）
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('dm1', 'dlg1', 's1', 'c1', 0, 'brain', 'code', '讨论项目管理方案', Date.now());
    const hit = db
      .prepare(`SELECT m.content FROM dialogue_messages m JOIN dialogue_messages_fts f ON m.rowid=f.rowid WHERE dialogue_messages_fts MATCH ?`)
      .all('"项目管理"') as Array<{ content: string }>;
    expect(hit.length).toBe(1);
    expect(hit[0].content).toContain('项目管理');
  });

  it('schema_migrations 记录到 v19（全部迁移应用）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-initdb-'));
    initDb(join(dir, 'test.db'));
    const db = getDb();
    const max = db.prepare(`SELECT MAX(version) as v FROM schema_migrations`).get() as { v: number };
    expect(max.v).toBe(20);
  });
});
