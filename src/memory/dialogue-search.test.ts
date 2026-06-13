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
  v20.up(db); // 生产态：v18 后总跑 v20（多列 FTS），searchDialogueMessages 的 snippet 用列 2(content)
  return db;
}

/** 仅 v18（单列 content FTS）——用于验证 v20 对历史行的重索引效果 */
function makeFtsDbV18Only(): Database.Database {
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

/** makeFtsDb 已含 v20（多列）；此别名保留向后兼容 */
function makeFtsDbV20(): Database.Database {
  return makeFtsDb();
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

describe('v20 历史行重索引（UPDATE-trigger，原 rebuild 失效的回归守护）', () => {
  it('v18 阶段插入的历史行 → v20 后按 agent 名能命中（UPDATE 触发器重索引生效）', () => {
    const db = makeFtsDbV18Only(); // 仅 v18（单列 content-only 触发器）
    // v20 之前插入历史行 —— 此时 FTS 是 content-only（v18 触发器），agent 名未入索引
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('hist1', 'd1', 's1', 'c1', 0, 'brain', 'code', '历史消息部署记录', 1);
    // v20 之前：搜 brain 命中不了（content-only）
    expect(searchDialogueMessages(db, 'brain').length).toBe(0);
    // 跑 v20：DROP v18 触发器 + 建拼接触发器 + UPDATE-trigger 重索引历史行
    v20.up(db);
    // 现在 brain 应命中（UPDATE content=content 触发了拼接触发器，重索引历史行）
    expect(searchDialogueMessages(db, 'brain').length).toBe(1);
    expect(searchDialogueMessages(db, 'code').length).toBe(1);
    // content 关键词仍正常（用 ≥3 字 CJK 走 FTS 路径，验证 v20 重索引）
    expect(searchDialogueMessages(db, '部署记录').length).toBe(1);
    db.close();
  });
});

/**
 * 15.0 D3-2：2 字 CJK FTS 召回缺口的 LIKE 兜底回归测试。
 *
 * trigram tokenizer 至少需 3 字成窗，2 字 CJK（中文最常见词长，如"权限/部署/你好"）
 * 既不满足 `length>=3` 也不满足 `length>3` → sanitizeFtsQuery 返回 '""' → 修复前搜索永远返回空。
 * 修复：sanitizeFtsQuery 返回 '""' 时走 LIKE 兜底（escapeLikePattern 转义通配符 + buildLikeSnippet 高亮）。
 * 本组钉死这条兜底路径，防止再次回归为"中文短词搜不到"。
 */
describe('D3-2: 2 字 CJK LIKE 兜底（trigram 召回缺口）', () => {
  it('searchDialogueMessages 召回 2 字 CJK 短词（修复前返回空）', () => {
    const db = makeFtsDb();
    const ins = db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('1', 'd1', 's1', 'c1', 0, 'brain', 'code', '权限管理需要分级审批', 1);
    ins.run('2', 'd2', 's1', 'c2', 0, 'code', 'brain', '不相关的内容', 2);

    const hits = searchDialogueMessages(db, '权限');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('权限');
    // LIKE 路径用 buildLikeSnippet 产出 <mark> 高亮片段
    expect(hits[0].snippet).toContain('<mark>权限</mark>');
    db.close();
  });

  it('2 字 CJK 兜底尊重 sessionId 过滤', () => {
    const db = makeFtsDb();
    const ins = db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('1', 'd1', 's1', 'c1', 0, 'a', 'b', '部署上线流程', 1);
    ins.run('2', 'd2', 's2', 'c2', 0, 'a', 'b', '部署上线流程', 2);

    const s1 = searchDialogueMessages(db, '部署', { sessionId: 's1' });
    expect(s1.length).toBe(1);
    expect(s1[0].sessionId).toBe('s1');
    expect(searchDialogueMessages(db, '部署').length).toBe(2);
    db.close();
  });

  it('searchAgentChatMessages 召回 2 字 CJK（与 dialogue 路径对称）', () => {
    const db = makeFtsDb();
    db.prepare(
      `INSERT INTO agent_chat_messages (id, session_id, task_id, from_agent, to_agent, direction, content, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('1', 's1', 't1', 'conversation', 'code', 'request', '正在处理审批流程', 1);

    const hits = searchAgentChatMessages(db, '审批');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('审批');
    expect(hits[0].snippet).toContain('<mark>审批</mark>');
    db.close();
  });

  it('LIKE 模式转义：查询含 % _ 不被当通配符', () => {
    const db = makeFtsDb();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'a', 'b', '50%完成 2_3 计划', 1);

    // 查 '50%' 应只命中字面含 "50%" 的行，而非任何含 "50" 后接任意字符的行
    const hits = searchDialogueMessages(db, '50%');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe('50%完成 2_3 计划');
    db.close();
  });

  it('≥3 字 CJK 仍走 FTS 路径不受影响（回归）', () => {
    const db = makeFtsDb();
    db.prepare(
      `INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('1', 'd1', 's1', 'c1', 0, 'a', 'b', '项目管理的最佳实践', 1);

    // 4 字 → sanitizeFtsQuery 产出有效 token → FTS 路径（snippet 由 FTS snippet() 生成）
    const hits = searchDialogueMessages(db, '项目管理');
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain('<mark>');
    db.close();
  });
});
