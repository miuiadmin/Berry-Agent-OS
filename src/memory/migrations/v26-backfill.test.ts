import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ALL_MIGRATIONS } from './index.js';

/**
 * 对话内联统一（doc 22 期2）· v26 user-messages-backfill 迁移的 1-to-1 测试。
 *
 * 验证「闭合 v25 窗口」的一次性补漏：v25 之后新增、只落 conversations 的 user 行，
 * 被 v26 回填进 messages + message_blocks（供前端 /timeline 恢复）。
 *
 * 重点覆盖：
 *   - user 行回填为 messages 行 + 单 text block
 *   - 幂等（重跑 / 已被 v25 回填的行不重复）
 *   - 仅 user 行（assistant 行用 collector.messageId 落库，按 conversations.id 回填会重复 → 必须跳过）
 *   - redact 覆盖 pre-15.0 残留明文
 *   - 健壮性：缺表不抛错
 *
 * 用 :memory: 内存库 + 手建最小表结构，不依赖完整 schema / initDb。
 */
const v26 = ALL_MIGRATIONS.find((m) => m.version === 26)!;

/** 建含 conversations / messages / message_blocks 最小结构的内存库 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      client_msg_id TEXT,
      created_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      client_msg_id TEXT,
      task_id TEXT,
      created_at INTEGER
    );
    CREATE TABLE message_blocks (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER
    );
  `);
  return db;
}

describe('v26 user-messages-backfill 迁移 (doc 22 期2)', () => {
  it('回填 user 行到 messages + 单 text block', () => {
    const db = makeDb();
    const ins = db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, client_msg_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run('u1', 's1', 'user', '你好，帮我列目录', 'cm-1', 1000);
    ins.run('u2', 's1', 'user', '第二句用户消息', null, 2000);

    v26.up(db);

    // messages 表：两行 user，id 与 conversations 同源
    const msgs = db
      .prepare('SELECT id, role, client_msg_id, created_at FROM messages ORDER BY created_at')
      .all() as Array<{ id: string; role: string; client_msg_id: string | null; created_at: number }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: 'u1', role: 'user', client_msg_id: 'cm-1', created_at: 1000 });
    expect(msgs[1]).toMatchObject({ id: 'u2', role: 'user', client_msg_id: null, created_at: 2000 });

    // message_blocks：每行一个 text block，id 派生 blk-<conv.id>
    const blocks = db
      .prepare('SELECT id, message_id, seq, block_type, payload_json FROM message_blocks ORDER BY message_id')
      .all() as Array<{ id: string; message_id: string; seq: number; block_type: string; payload_json: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: 'blk-u1', message_id: 'u1', seq: 1, block_type: 'text' });
    expect(JSON.parse(blocks[0].payload_json)).toEqual({ type: 'text', text: '你好，帮我列目录' });
    expect(blocks[1].message_id).toBe('u2');
    db.close();
  });

  it('幂等：重复执行不产生重复行', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '重复测试', 1000);

    v26.up(db);
    v26.up(db); // 重跑

    const msgCount = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    const blockCount = (db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).c;
    expect(msgCount).toBe(1);
    expect(blockCount).toBe(1);
    db.close();
  });

  it('不回填 assistant 行（避免与 collector.messageId 落库重复）', () => {
    const db = makeDb();
    // assistant 行在 conversations 但尚未进 messages（模拟 v25 之后、phase1 之前的委派空窗）
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a1', 's1', 'assistant', '助手回复', 1000);

    v26.up(db);

    const msgCount = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    const blockCount = (db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).c;
    expect(msgCount).toBe(0); // assistant 不回填
    expect(blockCount).toBe(0);
    db.close();
  });

  it('跳过已在 messages 的 user 行（与 v25 已回填行不重复）', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '已被 v25 回填', 1000);
    // 模拟 v25 已把该行回填进 messages（同 id）
    db.prepare(
      'INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)',
    ).run('u1', 's1', 'user', 1000);

    v26.up(db);

    // 不重复插入、不额外建 block
    const msgCount = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(msgCount).toBe(1);
    // v25 回填的行 v26 不应再补 block（LEFT JOIN m.id IS NULL 已过滤）
    const blockCount = (db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).c;
    expect(blockCount).toBe(0);
    db.close();
  });

  it('redact：清洗 user 文本中的明文 secret', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '我的 key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 1000);

    v26.up(db);

    const payload = (db.prepare('SELECT payload_json FROM message_blocks').get() as { payload_json: string })
      .payload_json;
    expect(JSON.parse(payload).text).toContain('[REDACTED:anthropic_key]');
    expect(JSON.parse(payload).text).not.toContain('sk-ant-api03');
    db.close();
  });

  it('健壮性：conversations 表不存在时不抛错', () => {
    const db = new Database(':memory:'); // 空库
    expect(() => v26.up(db)).not.toThrow();
    db.close();
  });

  it('健壮性：无 user 行时无副作用', () => {
    const db = makeDb();
    // 只有 assistant 行
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a1', 's1', 'assistant', '无 user', 1000);

    v26.up(db);

    const msgCount = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(msgCount).toBe(0);
    db.close();
  });
});
