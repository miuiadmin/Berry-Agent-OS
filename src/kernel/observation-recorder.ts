/**
 * ObservationRecorder — 13.0 灵魂版 Brain 观察队列持久化器。
 *
 * 职责：
 * - 零 LLM：纯 SQLite INSERT/SELECT
 * - 持久化所有 Agent 间通信 + 工具调用 + 用户交互到 brain_observations 表
 * - 提供按类型 / 时间窗口 / 优先级查询，供 Brain INTERVENE / REVIEW 阶段消费
 * - 滚动窗口裁剪：每个 (session_id, task_id) 最多保留 500 条，超出按 priority ASC 裁剪
 *
 * 双重存储：SQLite 持久化（durable）+ 调用方在内存中可缓存 last 200
 * Brain 重启后可通过 queryRecent 恢复完整上下文
 *
 * 设计依据：13.0 灵魂版 §20.3
 */

import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('observation-recorder');

/** 观察类型枚举（与 brain_observations 表 CHECK 约束对齐） */
export type ObservationType =
  | 'dialogue_send'
  | 'dialogue_reply'
  | 'tool_call'
  | 'tool_result'
  | 'agent_event'
  | 'drift_signal'
  | 'user_interaction'
  | 'permission_judgment';

/** 优先级：0=critical 永不裁剪；1=normal 默认；2=verbose 优先裁剪 */
export type ObservationPriority = 0 | 1 | 2;

/** record() 入参 */
export interface RecordObservationInput {
  /** 会话 ID（与 conversations.session_id 对齐） */
  sessionId: string;
  /** 任务 ID（agent_tasks.id 或 correlationId） */
  taskId: string;
  /** 观察类型 */
  observationType: ObservationType;
  /** 发送方 Agent 名称 */
  fromAgent: string;
  /** 接收方 Agent 名称（事件类观察可为空） */
  toAgent?: string;
  /** 观察内容（自然语言或 JSON 字符串） */
  content: string;
  /** 优先级，默认 1（normal） */
  priority?: ObservationPriority;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 查询结果行 */
export interface ObservationRow {
  id: string;
  sessionId: string;
  taskId: string;
  seq: number;
  observationType: ObservationType;
  fromAgent: string;
  toAgent: string | null;
  content: string;
  priority: number;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * M1: 查询结果 + 截断元信息。
 *
 * C 级审核检测到 truncated=true 时应降级为 B 级 + 警告，
 * 因为 Brain 以为看了全部，其实有一部分被裁剪了。
 */
export interface ObservationQueryResult {
  /** 查询到的观察记录 */
  rows: ObservationRow[];
  /** 该 (session, task) 是否发生过裁剪（低优先级记录被删除） */
  truncated: boolean;
  /** 裁剪前历史峰值（用于判断丢失了多少数据） */
  peakCount: number;
  /** 当前窗口大小 */
  windowSize: number;
}

/** 默认滚动窗口大小（每个 task 最多保留多少条观察） */
export const DEFAULT_OBSERVATION_WINDOW = 500;

export class ObservationRecorder {
  private insertStmt: Database.Statement;
  private nextSeqStmt: Database.Statement;
  private db: Database.Database;
  private windowSize: number;

  /**
   * M1: 截断跟踪器。
   * key = `${sessionId}:${taskId}`，value = { peakCount, truncated }。
   * 当 prune 删除记录时标记 truncated=true 并更新 peakCount。
   */
  private truncationTracker = new Map<string, { peakCount: number; truncated: boolean }>();

  constructor(db: Database.Database, windowSize: number = DEFAULT_OBSERVATION_WINDOW) {
    this.db = db;
    this.windowSize = windowSize;
    this.insertStmt = db.prepare(`
      INSERT INTO brain_observations
        (id, session_id, task_id, seq, observation_type, from_agent, to_agent, content, priority, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.nextSeqStmt = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM brain_observations
      WHERE session_id = ? AND task_id = ?
    `);
  }

  /**
   * 记录一条观察。
   * 内部自动分配 seq（同 session_id+task_id 内单调递增），
   * 并在窗口超限时异步触发 prune。
   *
   * @returns 新插入行的 ID
   */
  record(input: RecordObservationInput): string {
    const id = genId('obs');
    const seq = (this.nextSeqStmt.get(input.sessionId, input.taskId) as { next_seq: number }).next_seq;
    const priority = input.priority ?? 1;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    try {
      this.insertStmt.run(
        id,
        input.sessionId,
        input.taskId,
        seq,
        input.observationType,
        input.fromAgent,
        input.toAgent ?? null,
        input.content,
        priority,
        metadataJson,
        Date.now(),
      );
    } catch (err) {
      logger.error({ err, sessionId: input.sessionId, taskId: input.taskId, type: input.observationType }, 'observation:insert failed');
      throw err;
    }

    // 窗口超限检测（每 50 条触发一次 prune 减少写放大）
    if (seq > 0 && seq % 50 === 0) {
      this.prune(input.sessionId, input.taskId);
    }

    return id;
  }

  /**
   * 查询指定 session 的最近 N 条观察（按时间倒序）。
   */
  queryRecent(sessionId: string, limit: number = 50, types?: ObservationType[]): ObservationRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT * FROM brain_observations
        WHERE session_id = ? AND observation_type IN (${placeholders})
        ORDER BY created_at DESC LIMIT ?
      `).all(sessionId, ...types, limit) as Array<Record<string, unknown>>;
      return rows.map(this.toRow);
    }

    const rows = this.db.prepare(`
      SELECT * FROM brain_observations
      WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.toRow);
  }

  /**
   * 按类型查询观察。
   */
  queryByType(sessionId: string, types: ObservationType[], limit: number = 20): ObservationRow[] {
    if (types.length === 0) return [];
    const placeholders = types.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM brain_observations
      WHERE session_id = ? AND observation_type IN (${placeholders})
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, ...types, limit) as Array<Record<string, unknown>>;
    return rows.map(this.toRow);
  }

  /**
   * 查询指定 task 的所有观察（按 seq 升序，用于 INTERVENE 阶段按时间线重建）。
   */
  queryByTask(taskId: string, sessionId?: string): ObservationRow[] {
    if (sessionId) {
      const rows = this.db.prepare(`
        SELECT * FROM brain_observations
        WHERE session_id = ? AND task_id = ?
        ORDER BY seq ASC
      `).all(sessionId, taskId) as Array<Record<string, unknown>>;
      return rows.map(this.toRow);
    }
    const rows = this.db.prepare(`
      SELECT * FROM brain_observations
      WHERE task_id = ?
      ORDER BY seq ASC
    `).all(taskId) as Array<Record<string, unknown>>;
    return rows.map(this.toRow);
  }

  /**
   * 滚动窗口裁剪：保留优先级最高 + 时间最新的 N 条，删除其余。
   * 使用 DELETE 限定行数避免长事务。
   *
   * M1: 裁剪时更新截断跟踪器，供 C 级审核检测保真度降级。
   */
  prune(sessionId: string, taskId: string): number {
    const count = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM brain_observations
      WHERE session_id = ? AND task_id = ?
    `).get(sessionId, taskId) as { cnt: number }).cnt;

    if (count <= this.windowSize) return 0;

    // M1: 更新截断跟踪器（记录峰值和截断标志）
    const trackerKey = `${sessionId}:${taskId}`;
    const tracker = this.truncationTracker.get(trackerKey) ?? { peakCount: 0, truncated: false };
    tracker.peakCount = Math.max(tracker.peakCount, count);
    tracker.truncated = true;
    this.truncationTracker.set(trackerKey, tracker);

    const toDelete = count - this.windowSize;
    // 优先删除 priority 最低（verbose=2）且最旧的记录
    // 关键 (critical=0) 永不删除
    const result = this.db.prepare(`
      DELETE FROM brain_observations
      WHERE id IN (
        SELECT id FROM brain_observations
        WHERE session_id = ? AND task_id = ? AND priority > 0
        ORDER BY priority ASC, created_at ASC
        LIMIT ?
      )
    `).run(sessionId, taskId, toDelete);

    if (result.changes > 0) {
      logger.debug({ sessionId, taskId, deleted: result.changes, window: this.windowSize, peak: tracker.peakCount }, 'observation:pruned');
    }
    return result.changes;
  }

  /**
   * 统计指定 session 的观察数量。
   */
  count(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM brain_observations WHERE session_id = ?',
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * M1: 查询指定 task 的全部观察，附带截断信息。
   *
   * C 级审核使用此方法：如果 truncated=true，说明观察队列被裁剪过，
   * Brain 以为看了全部其实没有，应降级为 B 级 + 警告。
   *
   * @param taskId 任务 ID
   * @param sessionId 会话 ID（可选，用于缩小查询范围）
   * @returns 观察记录 + 截断元信息
   */
  queryWithTruncationInfo(taskId: string, sessionId?: string): ObservationQueryResult {
    const rows = this.queryByTask(taskId, sessionId);
    const key = sessionId ? `${sessionId}:${taskId}` : '';
    const tracker = key ? this.truncationTracker.get(key) : undefined;

    return {
      rows,
      truncated: tracker?.truncated ?? false,
      peakCount: tracker?.peakCount ?? rows.length,
      windowSize: this.windowSize,
    };
  }

  /**
   * M1: 检查指定 (session, task) 是否发生过截断。
   */
  isTruncated(sessionId: string, taskId: string): boolean {
    return this.truncationTracker.get(`${sessionId}:${taskId}`)?.truncated ?? false;
  }

  private toRow = (raw: Record<string, unknown>): ObservationRow => ({
    id: raw.id as string,
    sessionId: raw.session_id as string,
    taskId: raw.task_id as string,
    seq: raw.seq as number,
    observationType: raw.observation_type as ObservationType,
    fromAgent: raw.from_agent as string,
    toAgent: (raw.to_agent as string | null) ?? null,
    content: raw.content as string,
    priority: raw.priority as number,
    metadata: raw.metadata_json ? JSON.parse(raw.metadata_json as string) : null,
    createdAt: raw.created_at as number,
  });
}