import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ALL_MIGRATIONS } from './migrations/index.js';
import { searchDialogueMessages, searchAgentChatMessages } from './dialogue-search.js';

/**
 * 15.0 FTS5 · dialogue-search 端到端测试。
 *
 * 验证 v18 migration 建立的 dialogue_messages_fts / agent_chat_messages_fts
 * 触发器自动同步 + searchDialogueMessages / searchAgentChatMessages 能召回：
 * 中文短语、英文词、sessionId 过滤、CJK 子串、太短 query 不召回。
 *
 * 用 :memory: 库手建三张源表后跑 v18.up（模拟生产 initDb 顺序：建表 → 跑迁移）。
 */
const v18 = ALL_MIGRATIONS.find((m) => m.version === 18)!;
const v20 = ALL_MIGRATIONS.find((m) => m.version === 20)!;

/** 建三张源表的最小结构（含 FTS 触发器引用的列）+ conversations_fts（复刻 v12），
 *  再跑 v18 建 dialogue/agent_chat FTS + 触发器 + conversations update 触发器 */
function makeFtsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE dialogue_messages (
      id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, session_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL, sequence_number INTEGER NOT NULL,
      from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, content TEXT NOT NULL,
      context_json TEXT, metadata_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_chat_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
      from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, direction TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'agent.question', content TEXT NOT NULL,
      correlation_id TEXT, created_at INTEGER NOT NULL
    );
    -- 复刻 v12 的 conversations_fts（表 + insert/delete 触发器；v18 只补 update 触发器）
    CREATE VIRTUAL TABLE conversations_fts USING fts5(content, content='conversations', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER conversations_fts_insert AFTER INSERT ON conversations BEGIN
      INSERT INTO conversations_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER conversations_fts_delete AFTER DELETE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);
  v18.up(db);
  return db;
}

/** makeFtsDb + v20（触发器改为拼接 from/to agent），用于验证按 agent 名召回 */
function makeFtsDbV20(): Database.Database {
  const db = makeFtsDb();
  v20.up(db);
  return db;
}

describe('v18 FTS5 + dialogue-search (15.0)', () => {
  it('searchDialogueMessages 召回中文短语', () => {
    const db = makeFtsDb();
    const ins = db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('1', 'dlg1', 's1', 'c1', 0, 'brain', 'code', '请帮我做项目管理的最佳实践总结', 1);
    ins.run('2', 'dlg1', 's1', 'c1', 1, 'code', 'brain', '这是关于代码重构的回复', 2);

    const hits = searchDialogueMessages(db, '项目管理');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('项目管理');
    expect(hits[0].fromAgent).toBe('brain');
    expect(hits[0].toAgent).toBe('code');
    db.close();
  });

  it('searchAgentChatMessages 召回英文关键词', () => {
    const db = makeFtsDb();
    db.prepare(
      `INSERT INTO agent_chat_messages (id, session_id, task_id, from_agent, to_agent, direction, content, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('1', 's1', 't1', 'conversation', 'code', 'request', 'please run the database migration now', 1);

    const hits = searchAgentChatMessages(db, 'database');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('database');
    db.close();
  });

  it('sessionId 过滤限定会话范围', () => {
    const db = makeFtsDb();
    const ins = db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('1', 'd1', 's1', 'c1', 0, 'a', 'b', '共享关键词部署', 1);
    ins.run('2', 'd2', 's2', 'c2', 0, 'a', 'b', '共享关键词部署', 2);

    const s1 = searchDialogueMessages(db, '关键词', { sessionId: 's1' });
    const all = searchDialogueMessages(db, '关键词');
    expect(s1.length).toBe(1);
    expect(s1[0].sessionId).toBe('s1');
    expect(all.length).toBe(2);
    db.close();
  });

  it('触发器在 insert 后自动同步 FTS（无需手动重建）', () => {
    const db = makeFtsDb();
    // 迁移跑完后才插入 —— 触发器应自动把新行加入索引
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'a', 'b', 'late-inserted migration content', 1);

    const hits = searchDialogueMessages(db, 'migration');
    expect(hits.length).toBe(1);
    db.close();
  });

  it('conversations_fts update 触发器：更新内容后索引同步', () => {
    const db = makeFtsDb();
    db.prepare(`INSERT INTO conversations (id, content) VALUES (?, ?)`).run('1', 'old content here');
    db.prepare(`UPDATE conversations SET content = ? WHERE id = ?`).run('brand-new-updated-text', '1');

    // 用 conversations_fts 直接验证（session_search 走的就是它）
    const rows = db
      .prepare(`SELECT c.content FROM conversations c JOIN conversations_fts f ON c.rowid = f.rowid WHERE conversations_fts MATCH ?`)
      .all('"brand-new-updated-text"') as Array<{ content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('brand-new-updated-text');
    db.close();
  });

  it('太短的 query 不召回', () => {
    const db = makeFtsDb();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'a', 'b', 'abcdefghij', 1);

    expect(searchDialogueMessages(db, 'a')).toEqual([]);
    expect(searchDialogueMessages(db, '')).toEqual([]);
    db.close();
  });

  it('limit 上限生效', () => {
    const db = makeFtsDb();
    const ins = db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 10; i++) {
      ins.run(`r${i}`, `d${i}`, 's1', `c${i}`, 0, 'a', 'b', '重复关键词部署', i);
    }
    expect(searchDialogueMessages(db, '关键词', { limit: 3 }).length).toBe(3);
    db.close();
  });
});

describe('v20 FTS 拼接 from/to agent（§5.2，按 agent 名召回）', () => {
  it('按 from_agent 名搜索能命中（v20 拼接后）', () => {
    const db = makeFtsDbV20();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'brain', 'code', '请帮我重构这个模块', 1);
    // v20 之前：搜 'brain'（agent 名）命中不了（只索引 content）；v20 拼接后能命中
    const hits = searchDialogueMessages(db, 'brain');
    expect(hits.length).toBe(1);
    expect(hits[0].fromAgent).toBe('brain');
    db.close();
  });

  it('按 to_agent 名搜索也能命中', () => {
    const db = makeFtsDbV20();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'brain', 'code', '部署到生产环境', 1);
    expect(searchDialogueMessages(db, 'code').length).toBe(1);
    db.close();
  });

  it('content 关键词搜索仍正常（v20 不破坏 content 召回）', () => {
    const db = makeFtsDbV20();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'brain', 'code', '项目管理的最佳实践', 1);
    expect(searchDialogueMessages(db, '项目管理').length).toBe(1);
    db.close();
  });
});
