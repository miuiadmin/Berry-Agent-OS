import type Database from 'better-sqlite3';
import type { IpcMessageType } from '../contracts/infrastructure.js';

export interface CapturedMessage {
  id: string;
  type: IpcMessageType;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: number;
  deliveredAt: number | null;
}

export interface CaptureFilter {
  type?: IpcMessageType | IpcMessageType[];
  from?: string;
  to?: string;
  correlationId?: string;
  since?: number;
}

export class IpcCapture {
  constructor(private readonly db: Database.Database) {}

  getAll(filter?: CaptureFilter): CapturedMessage[] {
    let sql = `SELECT id, type, "from", "to", payload, status, created_at as createdAt, delivered_at as deliveredAt FROM ipc_journal WHERE 1=1`;
    const params: unknown[] = [];

    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    if (filter?.from) {
      sql += ` AND "from" = ?`;
      params.push(filter.from);
    }
    if (filter?.to) {
      sql += ` AND "to" = ?`;
      params.push(filter.to);
    }
    if (filter?.since) {
      sql += ` AND created_at >= ?`;
      params.push(filter.since);
    }

    sql += ` ORDER BY created_at ASC`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; type: string; from: string; to: string;
      payload: string; status: string; createdAt: number; deliveredAt: number | null;
    }>;

    let results = rows.map(r => ({
      ...r,
      type: r.type as IpcMessageType,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));

    if (filter?.correlationId) {
      results = results.filter(r =>
        r.id.includes(filter.correlationId!) ||
        (r.payload as Record<string, unknown>).correlationId === filter.correlationId,
      );
    }

    return results;
  }

  getByType(type: IpcMessageType): CapturedMessage[] {
    return this.getAll({ type });
  }

  getFlow(correlationId: string): CapturedMessage[] {
    return this.getAll({ correlationId });
  }

  count(filter?: CaptureFilter): number {
    return this.getAll(filter).length;
  }

  assertHasMessage(filter: CaptureFilter, message?: string): void {
    const found = this.getAll(filter);
    if (found.length === 0) {
      throw new Error(message ?? `Expected IPC message matching ${JSON.stringify(filter)}, found none`);
    }
  }

  assertMessageOrder(types: IpcMessageType[]): void {
    const messages = this.getAll({ type: types });
    const typeOrder = messages.map(m => m.type);

    let lastIndex = -1;
    for (const expectedType of types) {
      const idx = typeOrder.indexOf(expectedType, lastIndex + 1);
      if (idx === -1) {
        throw new Error(`Expected message type "${expectedType}" after index ${lastIndex}, not found`);
      }
      lastIndex = idx;
    }
  }
}
