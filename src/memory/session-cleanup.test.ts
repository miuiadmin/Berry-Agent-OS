import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb, deleteSession } from './db.js';

/**
 * deleteSession 动态发现清会话（根治漏表）集成测试。
 *
 * 钉死不变量：删会话后所有 session_id / source_session_id 列的表该 sid 行 = 0（动态发现验证，
 * 覆盖之前手动列表漏的 13 张表），message_blocks 经显式 subquery 清（无 session_id 列），
 * source_session_id 列名变体（async_delegations）被捕获，幂等，FK 状态恢复，不影响其它 session。
 */
describe('deleteSession 动态发现清会话（根治漏表）', () => {
  let dir: string;
  const SID = 'ses_test_delete';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-deleteSession-'));
    initDb(join(dir, 'test.db'));
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 在多张 session_id 表插该 sid 的行（核心对话 + 任务链 + source_session_id 列名变体） */
  function seed(): void {
    const db = getDb();
    db.prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)').run('m1', SID, 'user', 1000);
    db.prepare('INSERT INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run('b1', 'm1', 'text', JSON.stringify({ type: 'text', text: 'hi' }), 1000);
    db.prepare('INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('t1', SID, 'corr1', 'test', 'tester', 'brain', '{}');
    db.prepare('INSERT INTO task_events (id, task_id, session_id, source, event_type) VALUES (?, ?, ?, ?, ?)')
      .run('te1', 't1', SID, 'brain', 'progress');
    // source_session_id 列名变体（async_delegations）—— 之前 DELETE 端点漏清
    db.prepare('INSERT INTO async_delegations (id, source_session_id, target_workspace_id, prompt) VALUES (?, ?, ?, ?)')
      .run('ad1', SID, 'ws1', 'do something');
  }

  /** 动态验证：所有 session_id / source_session_id 列的表该 sid 行 = 0（最严格，根治漏表） */
  function assertAllSessionTablesClean(): void {
    const db = getDb();
    const SHADOW = /_(data|idx|content|config|segdir|segments|docsize|stat)$/;
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name } of tables) {
      if (SHADOW.test(name)) continue;
      const cols = db.pragma(`table_info(${name})`) as { name: string }[];
      const col = cols.find((c) => c.name === 'session_id') ?? cols.find((c) => c.name === 'source_session_id');
      if (col) {
        const cnt = (db.prepare(`SELECT COUNT(*) AS c FROM ${name} WHERE ${col.name} = ?`).get(SID) as { c: number }).c;
        expect(cnt, `${name}.${col.name} 应清空`).toBe(0);
      }
    }
  }

  it('删会话后所有 session_id 表该 sid = 0（动态发现验证，覆盖之前漏的 13 张表）', () => {
    seed();
    const { cleanedTables } = deleteSession(SID);
    expect(cleanedTables).toBeGreaterThan(0); // 至少清了 messages/agent_tasks/task_events/async_delegations 等
    assertAllSessionTablesClean();
  });

  it('message_blocks 经 subquery 清（无 session_id 列，动态发现捕获不到，靠显式 subquery）', () => {
    seed();
    deleteSession(SID);
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ?').get('m1') as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id = ?').get('m1') as { c: number }).c).toBe(0);
  });

  it('source_session_id 列名变体也被清（async_delegations）', () => {
    seed();
    deleteSession(SID);
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS c FROM async_delegations WHERE source_session_id = ?').get(SID) as { c: number }).c).toBe(0);
  });

  it('幂等：重复 deleteSession 不报错（空集 DELETE）', () => {
    seed();
    deleteSession(SID);
    expect(() => deleteSession(SID)).not.toThrow();
  });

  it('FK 状态恢复：deleteSession 后 PRAGMA foreign_keys 回到原值', () => {
    const db = getDb();
    const before = db.pragma('foreign_keys', { simple: true });
    deleteSession(SID);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(before);
  });

  it('不影响其它 session（只清指定 sid）', () => {
    seed();
    const db = getDb();
    db.prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)').run('m2', 'ses_other', 'user', 2000);
    deleteSession(SID);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get('ses_other') as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(SID) as { c: number }).c).toBe(0);
  });
});
