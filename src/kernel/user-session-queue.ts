/**
 * 13.0 §13.5: 用户级并发控制队列 — 同 user 多个 session 时串行处理。
 *
 * 解决的问题：
 *   - 同一 user 多端 / 多 tab 同时发消息时，后端会并发处理（race condition）
 *   - 用户期待「一个会话串行」，多端看到的应该是「最新消息排队等待前一条完成」
 *
 * 工作机制：
 *   - 每个 userId 最多 1 个 active session（通过 SessionManager 状态判定）
 *   - 新消息到达时，若该 userId 已有 active session → 入等待队列（记录 correlationId + message）
 *   - active session 完成时（complete/timeout）→ 自动取出队列头部启动
 *   - 等待时通过 EventBus 发 user.session.queued 事件让前端显示「等待中」提示
 *
 * 边界：
 *   - 队列上限 5（默认），超过丢弃 + 报错（避免无界排队）
 *   - 队列项 60s 超时（default）→ 主动 reject 防止 stale 任务卡死
 */

import { getEventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';

const logger = getLogger('user-session-queue');

export interface QueuedSession {
  id: string;
  userId: string;
  correlationId: string;
  enqueuedAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface UserSessionQueueConfig {
  maxQueueDepth: number;
  queueTimeoutMs: number;
}

const DEFAULT_CONFIG: UserSessionQueueConfig = {
  maxQueueDepth: 5,
  queueTimeoutMs: 60_000,
};

export class UserSessionQueue {
  private queues = new Map<string, QueuedSession[]>();
  private config: UserSessionQueueConfig;

  constructor(config: Partial<UserSessionQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 把 session 加入 user 的等待队列（当 user 已有 active session 时调用）。
   *
   * @returns 队列位置（0-based）；-1 表示队列满拒绝
   */
  enqueue(userId: string, correlationId: string): number {
    const queue = this.queues.get(userId) ?? [];

    if (queue.length >= this.config.maxQueueDepth) {
      logger.warn({ userId, correlationId, queueDepth: queue.length }, 'user-session-queue: queue full, reject');
      return -1;
    }

    const entry: QueuedSession = {
      id: genId('uqueue'),
      userId,
      correlationId,
      enqueuedAt: Date.now(),
    };

    // 队列项超时（防止 stale 任务卡死）
    entry.timeoutId = setTimeout(() => {
      const q = this.queues.get(userId);
      if (!q) return;
      const idx = q.findIndex(e => e.id === entry.id);
      if (idx !== -1) {
        q.splice(idx, 1);
        if (q.length === 0) this.queues.delete(userId);
        logger.warn({ userId, correlationId, queuedMs: Date.now() - entry.enqueuedAt }, 'user-session-queue: queued item timed out');
      }
    }, this.config.queueTimeoutMs);

    queue.push(entry);
    this.queues.set(userId, queue);

    // 通知前端
    getEventBus().emit('user.session.queued' as any, {
      userId,
      correlationId,
      position: queue.length - 1,
      enqueuedAt: entry.enqueuedAt,
    });

    logger.info({ userId, correlationId, position: queue.length - 1 }, 'user-session-queue: session queued');
    return queue.length - 1;
  }

  /**
   * 用户完成一个 session 后调用 — 取出队列头部 session 启动它。
   *
   * @returns 取出的 session（如有）或 null
   */
  dequeue(userId: string): QueuedSession | null {
    const queue = this.queues.get(userId);
    if (!queue || queue.length === 0) return null;

    const head = queue.shift()!;
    if (head.timeoutId) clearTimeout(head.timeoutId);
    if (queue.length === 0) this.queues.delete(userId);

    logger.info({ userId, correlationId: head.correlationId, queuedMs: Date.now() - head.enqueuedAt }, 'user-session-queue: session dequeued');

    // 通知前端可以启动
    getEventBus().emit('user.session.dequeued' as any, {
      userId,
      correlationId: head.correlationId,
      waitedMs: Date.now() - head.enqueuedAt,
    });

    return head;
  }

  /**
   * 获取用户的当前队列长度。
   */
  getQueueDepth(userId: string): number {
    return this.queues.get(userId)?.length ?? 0;
  }

  /**
   * 列出用户的等待队列（用于 UI 显示「等待中」列表）。
   */
  listQueued(userId: string): QueuedSession[] {
    return this.queues.get(userId) ?? [];
  }

  /**
   * 用户的所有 session 都完成 / 取消时清理队列。
   */
  clearForUser(userId: string, reason: string): number {
    const queue = this.queues.get(userId);
    if (!queue) return 0;
    const count = queue.length;
    for (const entry of queue) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
    }
    this.queues.delete(userId);
    logger.info({ userId, count, reason }, 'user-session-queue: cleared');
    return count;
  }

  /**
   * 列出所有有等待队列的 userId（用于运维 dashboard）。
   */
  listAllUserIds(): string[] {
    return [...this.queues.keys()];
  }
}

/** 全局单例 */
let globalQueue: UserSessionQueue | null = null;

export function getUserSessionQueue(): UserSessionQueue {
  if (!globalQueue) {
    globalQueue = new UserSessionQueue();
  }
  return globalQueue;
}

export function resetUserSessionQueue(): void {
  globalQueue = null;
}