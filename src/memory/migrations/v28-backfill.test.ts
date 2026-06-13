import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ALL_MIGRATIONS } from './index.js';

/**
 * 对话内联统一（doc 22）· v28 conversations-orphan-backfill 迁移的 1-to-1 测试。
 *
 * v28 收口 v25/v26 的缺口：把 conversations 里仍残留、不在 messages 的孤行（user + assistant）
 * 一次性回填进新表。根因是服务跑老代码（消灭双轨制之前）持续向 conversations 写新行制造孤子，
 * 而 v25 只跑一次、v26 只回填 user——这些孤行（尤其 assistant）永远进不了 messages，
 * /state（读 messages）刷新会丢历史对话正文。
 *
 * 重点覆盖：
 *   - user + assistant 孤行都回填（v26 只回填 user 的补集）
 *   - assistant 的 reasoning → thinking block；content → text block
 *   - 幂等（重跑 / 已在 messages 的行不重复）
 *   - redact 覆盖历史明文
 *   - 健壮性：缺表不抛错
 *
 * 用 :memory: 内存库 + 手建最小表结构，不依赖完整 schema / initDb。
 */
const v28 = ALL_MIGRATIONS.find((m) => m.version === 28)!;

/** 建含 conversations / messages / message_blocks 最小结构的内存库（含 reasoning 列） */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      reasoning TEXT,
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

describe('v28 conversations-orphan-backfill 迁移 (doc 22)', () => {
  it('回填 user + assistant 孤行到 messages（v26 只回填 user 的补集）', () => {
    const db = makeDb();
    const ins = db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    // user 孤行（无 reasoning）
    ins.run('u1', 's1', 'user', '帮我列目录', null, 1000);
    // assistant 孤行（带 reasoning → 应产 thinking block）
    ins.run('a1', 's1', 'assistant', '已为你列出', '先分析再执行', 2000);
    // assistant 孤行（无 reasoning → 仅 text block）
    ins.run('a2', 's1', 'assistant', '简短回复', null, 3000);

    v28.up(db);

    const msgs = db
      .prepare('SELECT id, role FROM messages ORDER BY created_at')
      .all() as Array<{ id: string; role: string }>;
    expect(msgs.map((m) => m.id).sort()).toEqual(['a1', 'a2', 'u1']);

    // a1（带 reasoning）：thinking + text 两个 block
    const a1Blocks = db
      .prepare('SELECT block_type, payload_json FROM message_blocks WHERE message_id = ? ORDER BY seq')
      .all('a1') as Array<{ block_type: string; payload_json: string }>;
    expect(a1Blocks.map((b) => b.block_type)).toEqual(['thinking', 'text']);
    expect(JSON.parse(a1Blocks[0].payload_json)).toEqual({ type: 'thinking', text: '先分析再执行' });
    expect(JSON.parse(a1Blocks[1].payload_json)).toEqual({ type: 'text', text: '已为你列出' });

    // a2（无 reasoning）：仅 text block
    const a2Blocks = db
      .prepare('SELECT block_type FROM message_blocks WHERE message_id = ?')
      .all('a2') as Array<{ block_type: string }>;
    expect(a2Blocks.map((b) => b.block_type)).toEqual(['text']);
  });

  it('幂等：重复执行不产生重复行', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '重复测试', 1000);

    v28.up(db);
    v28.up(db); // 重跑

    expect((db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).c).toBe(1);
  });

  it('跳过已在 messages 的行（LEFT JOIN m.id IS NULL 过滤）', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '已在 messages', 1000);
    // 模拟该行已进 messages（同 id）—— v28 不应重复回填
    db.prepare(
      'INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)',
    ).run('u1', 's1', 'user', 1000);

    v28.up(db);

    expect((db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).c).toBe(0);
  });

  it('redact：清洗历史明文 secret（user + assistant 文本）', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('a1', 's1', 'assistant', '我的 key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz', '推理含 ghp_1234567890abcdefghijklmnopqrstuvwxyz', 1000);

    v28.up(db);

    const blocks = db
      .prepare('SELECT payload_json FROM message_blocks WHERE message_id = ?')
      .all('a1') as Array<{ payload_json: string }>;
    const allText = blocks.map((b) => JSON.parse(b.payload_json).text).join('|');
    expect(allText).toContain('[REDACTED:anthropic_key]');
    expect(allText).toContain('[REDACTED:github_pat]');
    expect(allText).not.toContain('sk-ant-api03');
  });

  it('健壮性：conversations 表不存在时不抛错', () => {
    const db = new Database(':memory:'); // 空库
    expect(() => v28.up(db)).not.toThrow();
    db.close();
  });

  it('无孤行时无副作用（messages/与 message_blocks 不变）', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('u1', 's1', 'user', '已回填', 1000);
    db.prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)').run('u1', 's1', 'user', 1000);

    v28.up(db);

    expect((db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(1);
    db.close();
  });
});
