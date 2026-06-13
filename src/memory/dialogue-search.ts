import type Database from 'better-sqlite3';
import { sanitizeFtsQuery } from './search.js';
import type { CapabilityBus } from '../bus/capability-bus.js';

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
 * 15.0 D3-2：转义 LIKE 模式的通配符（%、_、\），避免用户查询里的这些字符被当通配符。
 * 配合 `LIKE ? ESCAPE '\\'` 使用。
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 15.0 D3-2：LIKE 兜底路径的 snippet 构造（FTS 的 snippet() 函数不可用）。
 * 在 content 中定位 term（大小写不敏感）首次出现位置，取前后各 radius 字符的窗口，
 * 用 <mark> 包裹匹配子串。找不到则返回 content 头部截断。
 */
function buildLikeSnippet(content: string, term: string, radius = 32): string {
  const idx = content.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return content.slice(0, radius * 2) + (content.length > radius * 2 ? '...' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + term.length + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  const matched = content.slice(idx, idx + term.length);
  return `${prefix}${content.slice(start, idx)}<mark>${matched}</mark>${content.slice(idx + term.length, end)}${suffix}`;
}

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
  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const match = sanitizeFtsQuery(query);

  // FTS 可命中（trigram tokenizer 至少需 3 字成窗）→ MATCH 路径
  if (match && match !== '""') {
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
               snippet(dialogue_messages_fts, 2, '<mark>', '</mark>', '...', 24) AS snippet,
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

  // 15.0 D3-2：FTS 无法召回的 sub-trigram 查询（最典型：2 字 CJK 短词如"权限/你好"——
  // 中文最常见词长）走 LIKE 兜底，否则这类词永远搜不到。转义通配符防注入/误匹配。
  const likePattern = `%${escapeLikePattern(query.trim())}%`;
  const conditions = ['m.content LIKE ? ESCAPE \'\\\''];
  const params: unknown[] = [likePattern];
  if (options?.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(options.sessionId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `
      SELECT m.rowid, m.session_id AS sessionId, m.dialogue_id AS dialogueId,
             m.from_agent AS fromAgent, m.to_agent AS toAgent, m.content,
             m.created_at AS createdAt
      FROM dialogue_messages m
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
    )
    .all(...params) as Array<Omit<DialogueSearchHit, 'snippet'>>;
  const term = query.trim();
  return rows.map((r) => ({ ...r, snippet: buildLikeSnippet(r.content, term) }));
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
  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const match = sanitizeFtsQuery(query);

  // FTS 可命中 → MATCH 路径
  if (match && match !== '""') {
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
               snippet(agent_chat_messages_fts, 2, '<mark>', '</mark>', '...', 24) AS snippet,
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

  // 15.0 D3-2：sub-trigram 查询（2 字 CJK 等）走 LIKE 兜底，与 searchDialogueMessages 对称
  const likePattern = `%${escapeLikePattern(query.trim())}%`;
  const conditions = ['m.content LIKE ? ESCAPE \'\\\''];
  const params: unknown[] = [likePattern];
  if (options?.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(options.sessionId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `
      SELECT m.rowid, m.session_id AS sessionId, m.task_id AS taskId,
             m.from_agent AS fromAgent, m.to_agent AS toAgent, m.direction, m.content,
             m.created_at AS createdAt
      FROM agent_chat_messages m
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
    )
    .all(...params) as Array<Omit<AgentChatSearchHit, 'snippet'>>;
  const term = query.trim();
  return rows.map((r) => ({ ...r, snippet: buildLikeSnippet(r.content, term) }));
}

export interface DialogueSearchCapabilityInput {
  query: string;
  /** 检索范围：dialogue（Agent 间对话状态表）/ agent_chat（request/response 审计表），默认 dialogue */
  scope?: 'dialogue' | 'agent_chat';
  sessionId?: string;
  limit?: number;
}

/**
 * 注册 dialogue_search 能力到 CapabilityBus（15.0 FTS5 接线）。
 *
 * 让 Brain / 工具可全文检索 Agent 间历史对话（dialogue_messages）与审计日志
 * （agent_chat_messages）。注册模式参照 session_search（session-search.ts）。
 * 没有这个接线，searchDialogueMessages/searchAgentChatMessages 是无调用方的死代码。
 *
 * @param bus  能力总线
 * @param db   数据库连接
 */
export function registerDialogueSearchCapability(bus: CapabilityBus, db: Database.Database): void {
  bus.register(
    {
      name: 'dialogue_search',
      description:
        'Full-text search across inter-agent dialogue history (dialogue_messages) and audit log (agent_chat_messages). Pass scope to pick table; optional sessionId to limit range.',
      dangerLevel: 'safe',
      provider: { type: 'builtin', name: 'memory' },
    },
    async (input) => {
      const { query, scope = 'dialogue', sessionId, limit } = input as DialogueSearchCapabilityInput;
      if (!query || query.trim().length < 2) {
        return { results: [], total: 0, reason: 'query too short' };
      }
      try {
        const hits =
          scope === 'agent_chat'
            ? searchAgentChatMessages(db, query, { sessionId, limit })
            : searchDialogueMessages(db, query, { sessionId, limit });
        return { results: hits, total: hits.length, scope };
      } catch {
        // FTS 索引可能尚未建（v18 未跑）—— 不抛错，返回空
        return { results: [], total: 0, error: 'dialogue search failed (FTS index may not exist)' };
      }
    },
  );
}
