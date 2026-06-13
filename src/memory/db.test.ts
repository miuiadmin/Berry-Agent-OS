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

  it('schema_migrations 记录到 v26（全部迁移应用）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-initdb-'));
    initDb(join(dir, 'test.db'));
    const db = getDb();
    const max = db.prepare(`SELECT MAX(version) as v FROM schema_migrations`).get() as { v: number };
    expect(max.v).toBe(26);
  });

  /**
   * 消灭双轨制回归：message_blocks_fts 启动期【增量】补齐。
   * 场景：v25→v26 升级——已存在数据使 FTS 非空，之后 v26 回填（绕过 repo 直写 message_blocks）
   * 的 user 行不在 FTS。修复前 populateMessageBlocksFtsIfEmpty「FTS 非空即 skip」→ 这些行永不进 FTS、搜不到。
   * 修复后 populateMessageBlocksFts 增量补缺失行（block_id NOT IN 已索引集合），下次启动必补。
   */
  it('message_blocks_fts 启动期增量补齐：绕过 repo 直写的 block 下次启动补索引（幂等）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-fts-populate-'));
    const dbPath = join(dir, 'test.db');
    initDb(dbPath);
    const db = getDb();
    // 直写一条「已有数据」（模拟 v25 期历史，绕过 repo）——首次启动 FTS 空，下次启动等价全量索引
    db.prepare(`INSERT INTO messages (id, session_id, role, created_at) VALUES (?, 's1', 'assistant', 1000)`).run('m-exist');
    db.prepare(`INSERT INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at) VALUES (?, ?, 1, 'text', ?, 1000)`)
      .run('blk-exist', 'm-exist', JSON.stringify({ type: 'text', text: '历史数据项目管理' }));

    closeDb();
    initDb(dbPath);
    const db2 = getDb();
    // blk-exist 经首次增量 populate 进 FTS（FTS 此前为空→全量等价）
    expect((db2.prepare(`SELECT COUNT(*) AS c FROM message_blocks_fts WHERE block_id = ?`).get('blk-exist') as { c: number }).c).toBe(1);

    // 再直写一条「绕过 repo」的 block（模拟 v26 回填 / 迁移直写）——此刻 FTS 非空，该行不在 FTS
    db2.prepare(`INSERT INTO messages (id, session_id, role, created_at) VALUES (?, 's1', 'user', 2000)`).run('m-gap');
    db2.prepare(`INSERT INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at) VALUES (?, ?, 1, 'text', ?, 2000)`)
      .run('blk-gap', 'm-gap', JSON.stringify({ type: 'text', text: '窗口期遗漏的对话内容' }));
    expect((db2.prepare(`SELECT COUNT(*) AS c FROM message_blocks_fts WHERE block_id = ?`).get('blk-gap') as { c: number }).c).toBe(0);

    // 再次启动——【增量 populate 必须补这条】（修复前因 FTS 非空 skip 而遗漏）
    closeDb();
    initDb(dbPath);
    const db3 = getDb();
    expect((db3.prepare(`SELECT COUNT(*) AS c FROM message_blocks_fts WHERE block_id = ?`).get('blk-gap') as { c: number }).c).toBe(1);
    // 且可被 trigram 全文搜中
    const hit = db3.prepare(`SELECT content FROM message_blocks_fts WHERE message_blocks_fts MATCH ?`).all('"窗口期遗漏"') as Array<{ content: string }>;
    expect(hit.some((r) => r.content.includes('窗口期遗漏'))).toBe(true);
    // 幂等：再启动一次不产生重复 FTS 行
    closeDb();
    initDb(dbPath);
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM message_blocks_fts WHERE block_id = ?`).get('blk-gap') as { c: number }).c).toBe(1);
    closeDb();
  });
});
