import type { Database } from 'better-sqlite3';
import type { IpcMessage } from './types.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('ipc-resilience');

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 15000,
};

export function computeBackoff(attempt: number, config: RetryConfig = DEFAULT_RETRY): number {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  return Math.min(jitter, config.maxDelayMs);
}

export interface DeadLetter {
  id: string;
  message: IpcMessage;
  reason: string;
  attempts: number;
  createdAt: number;
}

export class DeadLetterQueue {
  constructor(private db: Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ipc_dead_letters (
        id TEXT PRIMARY KEY,
        msg_type TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        correlation_id TEXT,
        trace_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dead_letters_to ON ipc_dead_letters(to_agent);
      CREATE INDEX IF NOT EXISTS idx_dead_letters_created ON ipc_dead_letters(created_at);
    `);
  }

  enqueue(msg: IpcMessage, reason: string, attempts: number): void {
    this.db.prepare(`
      INSERT INTO ipc_dead_letters (id, msg_type, from_agent, to_agent, payload, reason, attempts, created_at, correlation_id, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.type,
      msg.from,
      msg.to,
      JSON.stringify(msg.payload),
      reason,
      attempts,
      Date.now(),
      msg.correlationId ?? null,
      msg.traceId ?? null,
    );
    metrics.counter('ipc_dead_letters_total').inc({ to: msg.to, reason });
    logger.warn({ msgId: msg.id, type: msg.type, to: msg.to, reason }, 'Message moved to dead-letter queue');
  }

  list(to?: string, limit = 50): DeadLetter[] {
    const sql = to
      ? `SELECT * FROM ipc_dead_letters WHERE to_agent = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM ipc_dead_letters ORDER BY created_at DESC LIMIT ?`;
    const rows = (to ? this.db.prepare(sql).all(to, limit) : this.db.prepare(sql).all(limit)) as Array<{
      id: string; msg_type: string; from_agent: string; to_agent: string;
      payload: string; reason: string; attempts: number; created_at: number;
      correlation_id: string | null; trace_id: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      message: {
        id: r.id,
        type: r.msg_type as IpcMessage['type'],
        from: r.from_agent,
        to: r.to_agent,
        payload: JSON.parse(r.payload),
        timestamp: r.created_at,
        correlationId: r.correlation_id ?? undefined,
        traceId: r.trace_id ?? undefined,
      } as IpcMessage,
      reason: r.reason,
      attempts: r.attempts,
      createdAt: r.created_at,
    }));
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM ipc_dead_letters WHERE id = ?').run(id);
  }

  purgeOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare('DELETE FROM ipc_dead_letters WHERE created_at < ?').run(cutoff);
    return result.changes;
  }
}

export interface BackpressureConfig {
  maxPendingPerAgent: number;
  warningThreshold: number;
}

const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxPendingPerAgent: 100,
  warningThreshold: 80,
};

export class BackpressureMonitor {
  private pendingCounts = new Map<string, number>();
  private listeners: Array<(agent: string, count: number) => void> = [];

  constructor(private config: BackpressureConfig = DEFAULT_BACKPRESSURE) {}

  increment(agent: string): boolean {
    const count = (this.pendingCounts.get(agent) ?? 0) + 1;
    this.pendingCounts.set(agent, count);

    if (count >= this.config.warningThreshold) {
      metrics.counter('ipc_backpressure_warnings_total').inc({ agent });
      for (const listener of this.listeners) listener(agent, count);
    }

    return count < this.config.maxPendingPerAgent;
  }

  decrement(agent: string): void {
    const count = Math.max(0, (this.pendingCounts.get(agent) ?? 1) - 1);
    if (count === 0) {
      this.pendingCounts.delete(agent);
    } else {
      this.pendingCounts.set(agent, count);
    }
  }

  getCount(agent: string): number {
    return this.pendingCounts.get(agent) ?? 0;
  }

  isOverloaded(agent: string): boolean {
    return this.getCount(agent) >= this.config.maxPendingPerAgent;
  }

  onBackpressure(listener: (agent: string, count: number) => void): void {
    this.listeners.push(listener);
  }
}

export interface PriorityMessage {
  message: IpcMessage;
  priority: number;
  enqueuedAt: number;
}

export class PrioritySendQueue {
  private queue: PriorityMessage[] = [];
  private draining = false;
  private sendFn: (msg: IpcMessage) => boolean;

  constructor(sendFn: (msg: IpcMessage) => boolean) {
    this.sendFn = sendFn;
  }

  enqueue(msg: IpcMessage, priority = 0): void {
    this.queue.push({ message: msg, priority, enqueuedAt: Date.now() });
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (this.sendFn(item.message)) {
        this.queue.shift();
      } else {
        break;
      }
    }
    this.draining = false;
  }

  get pending(): number {
    return this.queue.length;
  }

  retry(): void {
    this.drain();
  }
}
