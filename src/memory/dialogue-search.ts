import type Database from 'better-sqlite3';
import { sanitizeFtsQuery } from './search.js';

/** dialogue_messages 全文检索命中项（v18 建立的 dialogue_messages_fts） */
export interface DialogueSearchHit {
  rowid: number;
  sessionId: string;
  dialogueId: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  /** 命中片段（<mark> 高亮包裹匹配子串） */
  snippet: string;
  createdAt: number;
}

/** agent_chat_messages 全文检索命中项（v18 建立的 agent_chat_messages_fts） */
export interface AgentChatSearchHit {
  rowid: number;
  sessionId: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  direction: string;
  content: string;
  snippet: string;
  createdAt: number;
}

export interface DialogueSearchOptions {
  /** 限定会话范围（不传则跨会话全局检索） */
  sessionId?: string;
  /** 最大返回条数（默认 20，上限 100） */
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** query 最短长度（与 session_search 一致，太短不召回） */
const MIN_QUERY_LEN = 2;

/**
 * 15.0 FTS5：跨 agent 对话内容检索（dialogue_messages 表）。
 *
 * 利用 v18 建立的 dialogue_messages_fts（trigram 外部内容表）做 MATCH 查询，
 * JOIN 回源表取完整字段 + snippet 高亮。query 经 sanitizeFtsQuery 清洗 ——
 * CJK 段落按 3 字滑窗切片，保证 trigram tokenizer 下中文短语可被召回。
 *
 * @param db    数据库连接（注入式，便于测试用 :memory: 库）
 * @param query 自由文本检索词
 * @param options.sessionId 限定会话；options.limit 上限
 * @returns 按相关度 + 时间倒序的命中项；query 太短或无命中返回空数组
 */
export function searchDialogueMessages(
  db: Database.Database,
  query: string,
  options?: DialogueSearchOptions,
): DialogueSearchHit[] {
  if (!query || query.trim().length < MIN_QUERY_LEN) return [];
  const match = sanitizeFtsQuery(query);
  if (!match || match === '""') return [];

  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = ['dialogue_messages_fts MATCH ?'];
  const params: unknown[] = [match];
  if (options?.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(options.sessionId);
  }
  params.push(limit);

  // 列别名直接产出 camelCase 字段，避免 JS 层映射
  return db
    .prepare(
      `
      SELECT m.rowid, m.session_id AS sessionId, m.dialogue_id AS dialogueId,
             m.from_agent AS fromAgent, m.to_agent AS toAgent, m.content,
             snippet(dialogue_messages_fts, 0, '<mark>', '</mark>', '...', 24) AS snippet,
             m.created_at AS createdAt
      FROM dialogue_messages m
      JOIN dialogue_messages_fts f ON m.rowid = f.rowid
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank, m.created_at DESC
      LIMIT ?
    `,
    )
    .all(...params) as DialogueSearchHit[];
}

/**
 * 15.0 FTS5：Agent 间对话审计检索（agent_chat_messages 表）。
 *
 * 与 searchDialogueMessages 平行，检索前端 agent-chat 面板背后的审计表。
 * Brain 审核 / 调试回溯历史 Agent 交互时使用。可按 sessionId 限定范围。
 */
export function searchAgentChatMessages(
  db: Database.Database,
  query: string,
  options?: DialogueSearchOptions,
): AgentChatSearchHit[] {
  if (!query || query.trim().length < MIN_QUERY_LEN) return [];
  const match = sanitizeFtsQuery(query);
  if (!match || match === '""') return [];

  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = ['agent_chat_messages_fts MATCH ?'];
  const params: unknown[] = [match];
  if (options?.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(options.sessionId);
  }
  params.push(limit);

  return db
    .prepare(
      `
      SELECT m.rowid, m.session_id AS sessionId, m.task_id AS taskId,
             m.from_agent AS fromAgent, m.to_agent AS toAgent, m.direction, m.content,
             snippet(agent_chat_messages_fts, 0, '<mark>', '</mark>', '...', 24) AS snippet,
             m.created_at AS createdAt
      FROM agent_chat_messages m
      JOIN agent_chat_messages_fts f ON m.rowid = f.rowid
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank, m.created_at DESC
      LIMIT ?
    `,
    )
    .all(...params) as AgentChatSearchHit[];
}
