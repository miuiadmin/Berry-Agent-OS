import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { getEventBus } from './event-bus.js';

const logger = getLogger('human-delegation');

export type DelegationStatus = 'pending' | 'approved' | 'denied' | 'timeout' | 'cancelled';
export type DelegationUrgency = 'low' | 'normal' | 'high' | 'critical';

export interface HumanDelegation {
  id: string;
  sessionId: string;
  requestedBy: string;
  title: string;
  description: string;
  urgency: DelegationUrgency;
  context: Record<string, unknown>;
  options: string[];
  status: DelegationStatus;
  userResponse: string | null;
  timeoutMs: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface CreateDelegationInput {
  sessionId: string;
  requestedBy: string;
  title: string;
  description: string;
  urgency?: DelegationUrgency;
  context?: Record<string, unknown>;
  options?: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class HumanDelegationManager {
  private pendingCallbacks = new Map<string, (response: string | null) => void>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  async requestDelegation(input: CreateDelegationInput): Promise<{ delegationId: string; response: string | null }> {
    const id = genId('hdel');
    const now = Date.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.db.prepare(`
      INSERT INTO human_delegations (id, session_id, requested_by, title, description, urgency, context_json, options_json, status, timeout_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      input.sessionId,
      input.requestedBy,
      input.title,
      input.description,
      input.urgency ?? 'normal',
      JSON.stringify(input.context ?? {}),
      JSON.stringify(input.options ?? ['approve', 'deny']),
      timeoutMs,
      now,
    );

    // Emit event for frontend consumption
    getEventBus().emit('delegation.user_needed', {
      delegationId: id,
      sessionId: input.sessionId,
      requestedBy: input.requestedBy,
      title: input.title,
      description: input.description,
      urgency: input.urgency ?? 'normal',
      options: input.options ?? ['approve', 'deny'],
    });

    logger.info({ delegationId: id, title: input.title, urgency: input.urgency }, 'Human delegation requested');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        this.timeouts.delete(id);
        this.resolve(id, null, 'timeout');
        resolve({ delegationId: id, response: null });
      }, timeoutMs);

      this.timeouts.set(id, timeout);
      this.pendingCallbacks.set(id, (response) => {
        resolve({ delegationId: id, response });
      });
    });
  }

  resolve(delegationId: string, userResponse: string | null, status?: DelegationStatus): boolean {
    const now = Date.now();
    const finalStatus = status ?? (userResponse ? 'approved' : 'denied');

    const result = this.db.prepare(`
      UPDATE human_delegations SET status = ?, user_response = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(finalStatus, userResponse, now, delegationId);

    if (result.changes === 0) return false;

    // Clear timeout
    const timeout = this.timeouts.get(delegationId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(delegationId);
    }

    // Notify waiting callback
    const cb = this.pendingCallbacks.get(delegationId);
    if (cb) {
      this.pendingCallbacks.delete(delegationId);
      cb(userResponse);
    }

    logger.info({ delegationId, status: finalStatus }, 'Human delegation resolved');
    return true;
  }

  cancel(delegationId: string): boolean {
    return this.resolve(delegationId, null, 'cancelled');
  }

  getPending(sessionId?: string): HumanDelegation[] {
    try {
      const query = sessionId
        ? `SELECT * FROM human_delegations WHERE status = 'pending' AND session_id = ? ORDER BY created_at DESC`
        : `SELECT * FROM human_delegations WHERE status = 'pending' ORDER BY created_at DESC`;
      const rows = sessionId
        ? this.db.prepare(query).all(sessionId) as Array<Record<string, unknown>>
        : this.db.prepare(query).all() as Array<Record<string, unknown>>;
      return rows.map(rowToDelegation);
    } catch (e) {
      logger.debug({ err: e, sessionId }, 'getPending query failed');
      return [];
    }
  }

  getRecent(limit = 20): HumanDelegation[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM human_delegations ORDER BY created_at DESC LIMIT ?
      `).all(limit) as Array<Record<string, unknown>>;
      return rows.map(rowToDelegation);
    } catch (e) {
      logger.debug({ err: e }, 'getRecent query failed');
      return [];
    }
  }

  cleanup(): void {
    for (const [id, timeout] of this.timeouts) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.pendingCallbacks.clear();
  }

  /**
   * P2-10: 启动时清理残留的 pending 委托。
   *
   * 进程重启后 pendingCallbacks 和 timeouts 丢失，但 SQLite 中仍有 pending 状态的委托。
   * 这些委托的等待 Promise 已无法 resolve（agent 进程也已丢失），
   * 直接标记为 timeout 避免永远卡在 pending 状态。
   */
  recoverOnStartup(): { timedOut: number } {
    const now = Date.now();
    const stale = this.db.prepare(
      `SELECT id, session_id, timeout_ms, created_at FROM human_delegations WHERE status = 'pending'`,
    ).all() as Array<{ id: string; session_id: string; timeout_ms: number; created_at: number }>;

    let timedOut = 0;
    for (const row of stale) {
      const error = `委托因服务重启被标记超时（已等待 ${Math.round((now - row.created_at) / 1000)}s）`;
      this.db.prepare(
        `UPDATE human_delegations SET status = 'timeout', user_response = NULL, resolved_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(now, row.id);
      logger.info({ delegationId: row.id, sessionId: row.session_id }, '启动恢复: 残留委托已标记超时');
      timedOut++;
    }

    if (timedOut > 0) {
      logger.info({ timedOut }, '启动恢复: 残留委托清理完成');
    }
    return { timedOut };
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS human_delegations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('low','normal','high','critical')),
          context_json TEXT NOT NULL DEFAULT '{}',
          options_json TEXT NOT NULL DEFAULT '["approve","deny"]',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','timeout','cancelled')),
          user_response TEXT,
          timeout_ms INTEGER NOT NULL DEFAULT 300000,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_human_delegations_status ON human_delegations(status, session_id);
      `);
    } catch {
      // table may already exist
    }
  }
}

function rowToDelegation(row: Record<string, unknown>): HumanDelegation {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    requestedBy: row.requested_by as string,
    title: row.title as string,
    description: row.description as string,
    urgency: row.urgency as DelegationUrgency,
    context: JSON.parse(row.context_json as string),
    options: JSON.parse(row.options_json as string),
    status: row.status as DelegationStatus,
    userResponse: row.user_response as string | null,
    timeoutMs: row.timeout_ms as number,
    createdAt: row.created_at as number,
    resolvedAt: row.resolved_at as number | null,
  };
}
