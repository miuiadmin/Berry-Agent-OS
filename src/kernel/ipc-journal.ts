import type Database from 'better-sqlite3';
import type { IpcMessage, IpcMessageType } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ipc-journal');

/**
 * 全量 journal 业务消息类型。
 *
 * 为什么需要按业务重要性分层：
 * - 核心业务层（CRITICAL）：所有会影响任务执行/用户感知/审计链的消息，必须 100% journal，崩溃后必须能重放
 *   包括 agent→core 方向的 final.response / draft.response / turn.correction / dialogue.reply / tool.audit 等
 *   以及 11.0/12.0 引入的 verify.* / drift.check.* / superior.review.* / checkpoint.evaluate.* 等
 * - telemetry 层（TELEMETRY）：高频 stream 消息（task.telemetry / task.progress / llm_completed 等），
 *   走降采样 journal（10% 抽样），既保留大部分回放能力，又避免 journal 表爆炸
 *
 * 两侧通道都要 journal：
 * - IpcChannel.send（kernel 侧，core → agent）：在 src/kernel/ipc.ts
 * - IpcChildChannel.send（agent 侧，agent → core）：在 src/kernel/ipc.ts
 * 两侧都通过 shouldJournal(type) 决定是否走 record + markSent/markDelivered/markFailed 状态机
 */
const CRITICAL_JOURNALED_TYPES: Set<IpcMessageType> = new Set([
  // 业务主线：用户输入 / Agent 任务 / 结果
  'user.message',
  'agent.task',
  'agent.task.result',
  // 路由
  'route.request',
  'route.result',
  // 审核
  'review.request',
  'review.result',
  // agent→core 方向的核心业务结果
  'final.response',
  'draft.response',
  'turn.correction',
  'tool.audit',
  // 11.0 智能体间对话
  'dialogue.reply',
  // 12.0 语义漂移防护
  'verify.request',
  'verify.result',
  'drift.check.request',
  'drift.check.result',
  // 上级审核 + Checkpoint
  'superior.review.request',
  'superior.review.result',
  'checkpoint.evaluate',
  'checkpoint.evaluate.result',
]);

/**
 * Telemetry 层：高频消息降采样 journal（10%）。
 * 保留在 telemetry 层而非不 journal，是为了支持 stream 回放 + 调试。
 */
const TELEMETRY_JOURNALED_TYPES: Set<IpcMessageType> = new Set([
  'task.telemetry',
  'task.progress',
  'task.acknowledge',
  'task.started',
]);

/** Telemetry 抽样率：10%（分子），分母固定 10 */
const TELEMETRY_SAMPLE_NUMERATOR = 1;
const TELEMETRY_SAMPLE_DENOMINATOR = 10;

/**
 * journal 统一白名单：核心层 + telemetry 层。
 * shouldJournal 在该 set 内做快速判断，telemetry 抽样逻辑在 record 内额外判断。
 */
const JOURNALED_TYPES: Set<IpcMessageType> = new Set([
  ...CRITICAL_JOURNALED_TYPES,
  ...TELEMETRY_JOURNALED_TYPES,
]);

const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Journal 状态语义：
 * - pending: 已写入 journal，等待对端确认（默认初始状态）
 * - sent: 已写入 child 进程 IPC 管道（child.send 同步成功）
 * - delivered: 对端已确认收到（目前由 IpcChannel.replay 等显式路径触发；
 *             普通 send 因 child IPC 是同步管道写入 + 消息无 ack 协议，停留在 sent）
 * - failed: 同步发送失败 / 投递异常
 *
 * 状态机：
 *   record() → pending
 *   markSent() → sent   (child.send 同步成功)
 *   markDelivered() → delivered (replay 路径显式 ack 后)
 *   markFailed() → failed
 */
export type JournalStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export interface JournalEntry {
  id: string;
  type: IpcMessageType;
  from: string;
  to: string;
  payload: string;
  status: JournalStatus;
  createdAt: number;
  deliveredAt: number | null;
}

export class IpcJournal {
  private db: Database.Database;
  private retentionMs: number;

  constructor(db: Database.Database, retentionMs = DEFAULT_RETENTION_MS) {
    this.db = db;
    this.retentionMs = retentionMs;
    this.ensureSchema();
  }

  shouldJournal(type: IpcMessageType): boolean {
    return JOURNALED_TYPES.has(type);
  }

  /**
   * 当前消息是否命中 telemetry 抽样。
   * 核心层永远命中，telemetry 层按固定分子/分母（默认 10%）抽样。
   * 注意：抽样在 record() 内部按 msg.id 哈希做稳定抽样，确保同一 message id 多次调用结果一致。
   */
  shouldSampleTelemetry(msg: IpcMessage): boolean {
    if (!TELEMETRY_JOURNALED_TYPES.has(msg.type)) return false;
    const hash = simpleHash(msg.id);
    return hash % TELEMETRY_SAMPLE_DENOMINATOR < TELEMETRY_SAMPLE_NUMERATOR;
  }

  record(msg: IpcMessage): void {
    if (!this.shouldJournal(msg.type)) return;
    // Telemetry 层走降采样
    if (TELEMETRY_JOURNALED_TYPES.has(msg.type) && !this.shouldSampleTelemetry(msg)) return;
    try {
      this.db.prepare(`
        INSERT INTO ipc_journal (id, type, "from", "to", payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(msg.id, msg.type, msg.from, msg.to, JSON.stringify(msg.payload), msg.timestamp);
    } catch (err) {
      logger.error({ err, msgId: msg.id }, '写入 IPC journal 失败');
    }
  }

  /**
   * 标记消息已写入 child IPC 管道（child.send 同步成功）。
   * 注意：child IPC 是同步写入管道，并不代表对端已确认收到；
   * 对端 ack 路径（replay 后）才升级为 delivered。
   */
  markSent(msgId: string): void {
    try {
      this.db.prepare(`UPDATE ipc_journal SET status = 'sent' WHERE id = ? AND status = 'pending'`)
        .run(msgId);
    } catch (err) {
      logger.debug({ err, msgId }, 'markSent 失败');
    }
  }

  markDelivered(msgId: string): void {
    try {
      this.db.prepare(`UPDATE ipc_journal SET status = 'delivered', delivered_at = ? WHERE id = ?`)
        .run(Date.now(), msgId);
    } catch (err) {
      logger.debug({ err, msgId }, 'markDelivered 失败');
    }
  }

  markFailed(msgId: string): void {
    try {
      this.db.prepare(`UPDATE ipc_journal SET status = 'failed' WHERE id = ?`).run(msgId);
    } catch (err) {
      logger.debug({ err, msgId }, 'markFailed 失败');
    }
  }

  getPending(): JournalEntry[] {
    return this.db.prepare(`
      SELECT id, type, "from", "to", payload, status, created_at as createdAt, delivered_at as deliveredAt
      FROM ipc_journal WHERE status = 'pending' ORDER BY created_at ASC
    `).all() as JournalEntry[];
  }

  cleanup(): number {
    const cutoff = Date.now() - this.retentionMs;
    // W7 修复：扩展 cleanup 范围，删除过期的 failed 和 pending 记录
    // 之前只清理 delivered，导致永久失败或悬挂的记录无限累积
    const result = this.db.prepare(`
      DELETE FROM ipc_journal
      WHERE (status = 'delivered' AND delivered_at < ?)
         OR (status = 'failed' AND created_at < ?)
         OR (status = 'pending' AND created_at < ?)
    `).run(cutoff, cutoff, cutoff);
    if (result.changes > 0) {
      logger.debug({ cleaned: result.changes }, 'IPC journal 清理完成');
    }
    return result.changes;
  }

  /**
   * 重放指定 agent 的 pending 消息。Agent 重启后调用。
   * @param agentName 目标 agent 名
   * @param sendFn 发送函数，返回 true 表示投递成功
   * @param maxAgeMs 只重放 maxAgeMs 内的消息（默认 2 分钟，超过的认为已被全局 timeout 兜底）
   * @returns 成功重放的消息数
   */
  replay(agentName: string, sendFn: (msg: IpcMessage) => boolean, maxAgeMs = 120_000): number {
    const cutoff = Date.now() - maxAgeMs;
    const pending = this.getPending().filter(e => e.to === agentName && e.createdAt >= cutoff);
    let replayed = 0;

    for (const entry of pending) {
      try {
        const msg: IpcMessage = {
          id: entry.id,
          type: entry.type as IpcMessageType,
          from: entry.from,
          to: entry.to,
          payload: JSON.parse(entry.payload),
          timestamp: entry.createdAt,
        };
        const ok = sendFn(msg);
        if (ok) {
          this.markDelivered(entry.id);
          replayed++;
        } else {
          this.markFailed(entry.id);
        }
      } catch (err) {
        logger.debug({ err, entryId: entry.id }, 'journal replay entry failed');
        this.markFailed(entry.id);
      }
    }

    if (replayed > 0) {
      logger.info({ agentName, replayed, total: pending.length }, 'IPC journal replay 完成');
    }
    return replayed;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ipc_journal (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ipc_journal_status ON ipc_journal(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ipc_journal_created ON ipc_journal(created_at)`);
  }
}

/**
 * 简单稳定 hash（djb2 变体）。用于 telemetry 抽样的稳定映射：
 * 同 id 多次调用结果一致，保证 replay 路径与原 send 路径抽样一致。
 */
function simpleHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
