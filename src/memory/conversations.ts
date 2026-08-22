import { getDb } from './db.js';
import { genId } from '../utils/id.js';
import { redactSecrets } from '../observability/redaction.js';

/**
 * conversations 表（扁平 text + reasoning）—— **已退役为只读冷归档**。
 *
 * 消灭持久化双轨制（设计文档/废弃/22）后，对话内容唯一规范存储是 `messages` + `message_blocks`
 * （见 `./message-blocks-repo.ts`）：
 *   - user 消息活跃漏斗 = `persistUserMessage`
 *   - assistant 消息活跃漏斗 = `persistAssistantTurn`
 *   - 唯一对话读取原语 = `getTimeline` / `extractTextFromBlocks`
 *
 * 本文件的写入函数（saveMessage / saveUserMessage / updateAssistantMessage）已无任何活线调用方，
 * 保留仅为「冷归档读取 + 迁移回退」语义；下方的 `getHistory` 仍可用于读取历史冷数据
 * （v25/v26 已把 conversations 全量回填进新表，正常路径不依赖本表）。
 *
 * 旧表保留不 DROP（遵循项目既定原则 + doc 22「旧表保留为冷归档不立即 drop」）。
 */

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: number;
}

/**
 * 单行写入会话消息到 conversations 表。
 *
 * @deprecated 消灭双轨制（doc 22）后无活线调用方——assistant 落库走 `persistAssistantTurn`，
 *             user 落库走 `persistUserMessage`（均写 messages + message_blocks）。本函数仅冷归档保留。
 *
 * 该函数是最低层级的持久化原语：内部直接执行 SQL INSERT。
 * 既有调用方（saveConversationTurn / 其它内部）依赖此 API；
 * 上层（kernel 入口和 conversation agent）应通过更专门的
 * saveUserMessage / saveAssistantMessage 调用，避免重蹈「user 消息
 * 在中断时丢失」的覆辙。
 *
 * @param sessionId 会话 ID
 * @param role 消息角色
 * @param content 消息正文
 * @param reasoning 可选推理内容（仅 assistant 行使用）
 * @returns 新写入行的 id
 */
export function saveMessage(sessionId: string, role: 'user' | 'assistant', content: string, reasoning?: string): string {
  const db = getDb();
  const id = genId('msg');
  // 15.0 存储层加固：落盘前清洗 content / reasoning 中的 secret（API key / token / 私钥）
  const safeContent = redactSecrets(content);
  const safeReasoning = reasoning ? redactSecrets(reasoning) : null;
  db.prepare(`
    INSERT INTO conversations (id, session_id, role, content, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, role, safeContent, safeReasoning, Date.now());
  return id;
}

/**
 * 13.0 §5.3.12: 替换已落库的 assistant 消息为用户还原后的原始版本。
 *
 * @deprecated 消灭双轨制（doc 22）后 assistant 正文唯一在 message_blocks 的 text block——
 *             「还原 Brain 修改」改走 `replaceLastAssistantText`（写新表）。本函数仅冷归档保留。
 *
 * 用户点击「还原 Brain 的修改」时调用 — 同一 taskId 范围内的 assistant 行被覆盖。
 * 配套 in-memory history 更新（conversation agent 同步）。
 *
 * @returns 更新的行数（0 表示没找到对应消息）
 */
export function updateAssistantMessage(
  sessionId: string,
  taskId: string,
  newContent: string,
): number {
  const db = getDb();
  // 15.0 存储层加固：还原后的内容同样清洗 secret（防止历史里残留明文 key）
  const safeContent = redactSecrets(newContent);
  const result = db.prepare(`
    UPDATE conversations
    SET content = ?
    WHERE session_id = ?
      AND role = 'assistant'
      AND (id = ? OR (task_id IS NOT NULL AND task_id = ?))
    ORDER BY created_at DESC
    LIMIT 1
  `).run(safeContent, sessionId, taskId, taskId);
  return result.changes;
}

/**
 * 专门为「user 消息入口入库」设计的幂等保存 API。
 *
 * @deprecated 消灭双轨制（doc 22）后 user 消息活跃漏斗走 `persistUserMessage`（写 messages + 单 text block，
 *             同样幂等且经 redact 单漏斗）。本函数仅冷归档保留。
 *
 * 设计动机：
 * 1. 修复 user 消息在中断时丢失的 bug —— 任何路径（kernel 入口 /
 *    conversation agent / 重试 / 兜底）调用本函数都会在 conversations
 *    表里立刻留下一行 role='user' 的记录，**保证 user 消息在进入系统
 *    边界时就已经落盘**。
 * 2. 幂等性 —— 接受 clientMsgId 作为去重键。如果同一 clientMsgId
 *    已存在（kernel 入口已存过、conversation agent 再次触发），
 *    返回已存在行的 id，避免重复入库破坏对话顺序。
 *
 * @param sessionId 会话 ID
 * @param content 用户消息正文
 * @param options.clientMsgId 客户端消息 ID（可选），用作幂等键
 * @returns 新写入或已存在行的 id
 */
export function saveUserMessage(
  sessionId: string,
  content: string,
  options: { clientMsgId?: string } = {},
): { id: string; deduplicated: boolean } {
  const db = getDb();
  // 15.0 存储层加固：在入口处清洗 secret。查询（WHERE content = ?）与 INSERT
  // 都使用这份清洗后内容，保证幂等去重逻辑一致——同一原文不论重试几次落库结果相同。
  content = redactSecrets(content);

  // 幂等：优先按 (session_id, client_msg_id) 精确去重（UNIQUE 索引保证）
  // 同一会话内同 clientMsgId 的多次重试入库只会保留一行。
  // 没有 clientMsgId 时退化为 (session_id, content) + 5s 窗口（兼容旧调用方）。
  if (options.clientMsgId) {
    const existing = db
      .prepare(
        `SELECT id FROM conversations
         WHERE session_id = ? AND client_msg_id = ? AND role = 'user' LIMIT 1`,
      )
      .get(sessionId, options.clientMsgId) as { id: string } | undefined;
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }
  } else {
    // 无 clientMsgId 兜底：5s 窗口 + content 匹配（避免重写破坏向后兼容）
    const dedupeWindowMs = 5_000;
    const cutoff = Date.now() - dedupeWindowMs;
    const existing = db
      .prepare(
        `SELECT id, created_at FROM conversations
         WHERE session_id = ? AND content = ? AND role = 'user'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, content) as { id: string; created_at: number } | undefined;
    if (existing && existing.created_at >= cutoff) {
      return { id: existing.id, deduplicated: true };
    }
  }

  const id = genId('msg');
  try {
    db.prepare(`
      INSERT INTO conversations (id, session_id, role, content, reasoning, client_msg_id, created_at)
      VALUES (?, ?, 'user', ?, NULL, ?, ?)
    `).run(id, sessionId, content, options.clientMsgId ?? null, Date.now());
  } catch (err) {
    // UNIQUE 约束并发冲突：另一线程已插入同 clientMsgId 行 → 复用其 id
    if (options.clientMsgId && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = db
        .prepare(
          `SELECT id FROM conversations
           WHERE session_id = ? AND client_msg_id = ? AND role = 'user' LIMIT 1`,
        )
        .get(sessionId, options.clientMsgId) as { id: string } | undefined;
      if (existing) {
        return { id: existing.id, deduplicated: true };
      }
    }
    throw err;
  }
  return { id, deduplicated: false };
}

export function getHistory(sessionId: string, limit = 20): ConversationMessage[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
  ).all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

function rowToMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    reasoning: (row.reasoning as string) || undefined,
    createdAt: row.created_at as number,
  };
}
