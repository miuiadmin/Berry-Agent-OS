import type Database from 'better-sqlite3';
import type { IBusAuditLogger, BusAuditEntry } from './contract.js';
import { safeJsonParse } from '../utils/safe-json.js';

export class BusAuditLogger implements IBusAuditLogger {
  private db: Database.Database;
  private insertStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
  }

  record(entry: BusAuditEntry): void {
    try {
      if (!this.insertStmt) {
        this.insertStmt = this.db.prepare(`
          INSERT INTO capability_invocations
            (id, capability_name, provider_type, provider_name, caller_agent, session_id, correlation_id, call_chain, input_json, output_json, ok, error, duration_ms, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      this.insertStmt.run(
        entry.id,
        entry.capabilityName,
        entry.provider.type,
        entry.provider.name,
        entry.callerAgent,
        entry.sessionId,
        entry.correlationId,
        JSON.stringify(entry.callChain),
        truncateJson(entry.input),
        truncateJson(entry.output),
        entry.ok ? 1 : 0,
        entry.error,
        entry.durationMs,
        entry.createdAt,
      );
    } catch {
      // audit is best-effort, never fail the invocation
    }
  }

  getBySession(sessionId: string, limit = 100): BusAuditEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM capability_invocations WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  getByCorrelation(correlationId: string): BusAuditEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM capability_invocations WHERE correlation_id = ? ORDER BY created_at ASC
    `).all(correlationId) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_invocations (
        id TEXT PRIMARY KEY,
        capability_name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        caller_agent TEXT,
        session_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        call_chain TEXT NOT NULL DEFAULT '[]',
        input_json TEXT,
        output_json TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_cap_inv_session ON capability_invocations(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cap_inv_correlation ON capability_invocations(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_cap_inv_capability ON capability_invocations(capability_name, created_at);
    `);
  }
}

function truncateJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  if (json.length > 4096) return json.slice(0, 4096) + '…';
  return json;
}

function rowToEntry(row: Record<string, unknown>): BusAuditEntry {
  return {
    id: row.id as string,
    capabilityName: row.capability_name as string,
    provider: { type: row.provider_type as 'builtin' | 'agent' | 'plugin' | 'runtime', name: row.provider_name as string },
    callerAgent: row.caller_agent as string | null,
    sessionId: row.session_id as string,
    correlationId: row.correlation_id as string,
    callChain: safeJsonParse<string[]>(row.call_chain as string, []),
    input: row.input_json ? safeJsonParse<unknown>(row.input_json as string, null) : null,
    output: row.output_json ? safeJsonParse<unknown>(row.output_json as string, null) : null,
    ok: row.ok === 1,
    error: row.error as string | null,
    durationMs: row.duration_ms as number,
    createdAt: row.created_at as number,
  };
}
