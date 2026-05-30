import type Database from 'better-sqlite3';
import type { IpcMessage, IpcMessageType } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ipc-journal');

const JOURNALED_TYPES: Set<IpcMessageType> = new Set([
  'user.message',
  'agent.task',
  'agent.task.result',
  'route.request',
  'route.result',
  'review.request',
  'review.result',
  'final.response',
]);

const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

export interface JournalEntry {
  id: string;
  type: IpcMessageType;
  from: string;
  to: string;
  payload: string;
  status: 'pending' | 'delivered' | 'failed';
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

  record(msg: IpcMessage): void {
    if (!this.shouldJournal(msg.type)) return;
    try {
      this.db.prepare(`
        INSERT INTO ipc_journal (id, type, "from", "to", payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(msg.id, msg.type, msg.from, msg.to, JSON.stringify(msg.payload), msg.timestamp);
    } catch (err) {
      logger.error({ err, msgId: msg.id }, '写入 IPC journal 失败');
    }
  }

  markDelivered(msgId: string): void {
    this.db.prepare(`UPDATE ipc_journal SET status = 'delivered', delivered_at = ? WHERE id = ?`)
      .run(Date.now(), msgId);
  }

  markFailed(msgId: string): void {
    this.db.prepare(`UPDATE ipc_journal SET status = 'failed' WHERE id = ?`).run(msgId);
  }

  getPending(): JournalEntry[] {
    return this.db.prepare(`
      SELECT id, type, "from", "to", payload, status, created_at as createdAt, delivered_at as deliveredAt
      FROM ipc_journal WHERE status = 'pending' ORDER BY created_at ASC
    `).all() as JournalEntry[];
  }

  cleanup(): number {
    const cutoff = Date.now() - this.retentionMs;
    const result = this.db.prepare(`DELETE FROM ipc_journal WHERE status = 'delivered' AND delivered_at < ?`)
      .run(cutoff);
    if (result.changes > 0) {
      logger.debug({ cleaned: result.changes }, 'IPC journal 清理完成');
    }
    return result.changes;
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
