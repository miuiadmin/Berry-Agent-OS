import { getDb } from './db.js';
import { genId } from '../utils/id.js';
import { safeJsonParse } from '../utils/safe-json.js';
import { redactSecrets } from '../observability/redaction.js';

export type EpisodeEventType = 'user_message' | 'assistant_response' | 'tool_call' | 'memory_extracted' | 'error';

export interface Episode {
  id: string;
  sessionId: string;
  eventType: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/**
 * 写入一条 episode（事件流水）。
 *
 * 15.0 D3-1（V-4 补全）：content 是会话事件的自然语言摘要（用户消息 / Agent 回复 / 工具调用回显），
 * 与 conversations / dialogue_messages 的 content 同样可能内嵌密钥（用户在对话里贴的 key / Agent 转述的工具结果）。
 * 落库前 redact，避免明文密钥持久化到 episodes 表。
 *
 * eventType 是**自由标签**（不是封闭枚举）：各模块写自己的事件标签（如 skill-tools 的
 * 'skill_viewed' / 'skill_executed'），EpisodeEventType 仅枚举常见值供参考。故参数取 string。
 *
 * @param sessionId 会话 ID
 * @param eventType 事件类型（自由标签）
 * @param content   原始事件内容（将先 redact 再落库）
 * @param metadata  可选元数据（序列化后整体 redact）
 * @returns 新建的 episode ID
 */
export function logEpisode(sessionId: string, eventType: string, content: string, metadata?: Record<string, unknown>): string {
  const db = getDb();
  const id = genId('ep');
  // metadata 同样可能携带密钥（如 report_skill_outcome 的 note 字段是用户/Agent 自由文本，可内嵌 key）。
  // 序列化后整体 redactSecrets——占位符 [REDACTED:xxx] 是普通字符，落进 JSON 字符串值内不破坏结构。
  db.prepare(`
    INSERT INTO episodes (id, session_id, event_type, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, eventType, redactSecrets(content), metadata ? redactSecrets(JSON.stringify(metadata)) : null, Date.now());
  return id;
}

export function getEpisodes(sessionId: string, limit = 50): Episode[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    eventType: row.event_type as EpisodeEventType,
    content: row.content as string,
    metadata: row.metadata ? safeJsonParse<Record<string, unknown>>(row.metadata as string, {}) : undefined,
    createdAt: row.created_at as number,
  };
}
