import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ALL_MIGRATIONS } from './index.js';

/**
 * 15.0 存储层加固 · v17 redact-history-scan 迁移的 1-to-1 测试。
 *
 * redactSecrets 函数本身已有完整单测（observability/redaction.test.ts），
 * 这里只验证迁移的「扫描 + 按行 UPDATE」逻辑：能在三张对话/审计表里找出
 * 含明文 secret 的行并替换，且幂等、对缺表健壮。
 *
 * 用 :memory: 内存库 + 手建最小表结构，不依赖完整 schema / initDb。
 */
const v17 = ALL_MIGRATIONS.find((m) => m.version === 17)!;

/** 建一个仅含三张目标表最小列结构的内存库（只测 content 列扫描） */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE dialogue_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE agent_chat_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
  `);
  return db;
}

describe('v17 redact-history-scan 迁移 (15.0)', () => {
  it('清洗 conversations 历史明文 anthropic key，保留正常行', () => {
    const db = makeDb();
    const ins = db.prepare('INSERT INTO conversations (id, content) VALUES (?, ?)');
    ins.run('a', '我的 key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    ins.run('b', '今天天气不错，正常对话没有 secret');

    v17.up(db);

    const rows = db.prepare('SELECT id, content FROM conversations ORDER BY id').all() as Array<{ id: string; content: string }>;
    expect(rows[0].content).toBe('我的 key 是 [REDACTED:anthropic_key]');
    expect(rows[1].content).toBe('今天天气不错，正常对话没有 secret');
    db.close();
  });

  it('清洗 dialogue_messages 与 agent_chat_messages 两张审计表', () => {
    const db = makeDb();
    db.prepare('INSERT INTO dialogue_messages (id, content) VALUES (?, ?)').run('d', 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    db.prepare('INSERT INTO agent_chat_messages (id, content) VALUES (?, ?)').run('c', 'Authorization: Bearer abcdef1234567890xyzTOKEN123');

    v17.up(db);

    const d = db.prepare('SELECT content FROM dialogue_messages').get() as { content: string };
    const c = db.prepare('SELECT content FROM agent_chat_messages').get() as { content: string };
    expect(d.content).toContain('[REDACTED:github_pat]');
    expect(c.content).toContain('[REDACTED:bearer_token]');
    db.close();
  });

  it('幂等：重复执行不产生二次变化', () => {
    const db = makeDb();
    db.prepare('INSERT INTO conversations (id, content) VALUES (?, ?)').run('a', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');

    v17.up(db);
    const after1 = (db.prepare('SELECT content FROM conversations').get() as { content: string }).content;

    v17.up(db); // 已清洗的内容不会再匹配 secret 模式
    const after2 = (db.prepare('SELECT content FROM conversations').get() as { content: string }).content;

    expect(after2).toBe(after1);
    db.close();
  });

  it('健壮性：目标表全部不存在时不抛错', () => {
    const db = new Database(':memory:'); // 空库
    expect(() => v17.up(db)).not.toThrow();
    db.close();
  });

  it('只清洗 content，不动其它列', () => {
    const db = new Database(':memory:');
    // 故意只建 conversations 且加一列 meta，验证迁移不会误碰其它列
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, content TEXT NOT NULL, meta TEXT)`);
    db.prepare('INSERT INTO conversations (id, content, meta) VALUES (?, ?, ?)').run(
      'a',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'meta-should-not-change',
    );

    v17.up(db);

    const row = db.prepare('SELECT content, meta FROM conversations').get() as { content: string; meta: string };
    expect(row.content).toContain('[REDACTED:anthropic_key]');
    expect(row.meta).toBe('meta-should-not-change');
    db.close();
  });
});
