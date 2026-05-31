import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('suggestion-queue');

export interface PendingSuggestion {
  id: string;
  sessionId: string;
  source: 'will_loop' | 'learning' | 'brain';
  title: string;
  description: string;
  capability?: string;
  input?: unknown;
  urgency: 'low' | 'normal' | 'high';
  createdAt: number;
  deliveredAt: number | null;
}

export class SuggestionQueue {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  push(suggestion: {
    sessionId?: string;
    source: PendingSuggestion['source'];
    title: string;
    description: string;
    capability?: string;
    input?: unknown;
    urgency?: PendingSuggestion['urgency'];
  }): string {
    const id = genId('sug');
    this.db.prepare(`
      INSERT INTO suggestion_queue (id, session_id, source, title, description, capability, input_json, urgency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      suggestion.sessionId ?? 'global',
      suggestion.source,
      suggestion.title,
      suggestion.description,
      suggestion.capability ?? null,
      suggestion.input ? JSON.stringify(suggestion.input) : null,
      suggestion.urgency ?? 'normal',
      Date.now(),
    );
    return id;
  }

  getPending(sessionId?: string, limit = 5): PendingSuggestion[] {
    try {
      const query = sessionId
        ? `SELECT * FROM suggestion_queue WHERE delivered_at IS NULL AND (session_id = ? OR session_id = 'global') ORDER BY urgency DESC, created_at ASC LIMIT ?`
        : `SELECT * FROM suggestion_queue WHERE delivered_at IS NULL ORDER BY urgency DESC, created_at ASC LIMIT ?`;
      const rows = sessionId
        ? this.db.prepare(query).all(sessionId, limit) as Array<Record<string, unknown>>
        : this.db.prepare(query).all(limit) as Array<Record<string, unknown>>;
      return rows.map(rowToSuggestion);
    } catch (err) {
      logger.debug({ err, sessionId }, 'Failed to get pending suggestions');
      return [];
    }
  }

  markDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(`UPDATE suggestion_queue SET delivered_at = ? WHERE id = ?`);
    for (const id of ids) {
      stmt.run(now, id);
    }
  }

  buildPromptBlock(sessionId?: string): string {
    const pending = this.getPending(sessionId, 3);
    if (pending.length === 0) return '';

    const lines = pending.map(s => `- [${s.source}/${s.urgency}] ${s.title}: ${s.description}`);
    this.markDelivered(pending.map(s => s.id));

    return `\n## 待传达建议（Brain 可在适当时机告知用户）\n\n${lines.join('\n')}\n`;
  }

  cleanup(olderThanMs = 7 * 86400_000): number {
    const cutoff = Date.now() - olderThanMs;
    try {
      const result = this.db.prepare(`DELETE FROM suggestion_queue WHERE delivered_at IS NOT NULL AND delivered_at < ?`).run(cutoff);
      return result.changes;
    } catch (err) {
      logger.debug({ err }, 'Failed to cleanup delivered suggestions');
      return 0;
    }
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS suggestion_queue (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL DEFAULT 'global',
          source TEXT NOT NULL CHECK(source IN ('will_loop','learning','brain')),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          capability TEXT,
          input_json TEXT,
          urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('low','normal','high')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          delivered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_suggestion_pending ON suggestion_queue(delivered_at) WHERE delivered_at IS NULL;
      `);
    } catch (err) {
      logger.debug({ err }, 'suggestion_queue table ensure failed (may already exist)');
    }
  }
}

function rowToSuggestion(row: Record<string, unknown>): PendingSuggestion {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    source: row.source as PendingSuggestion['source'],
    title: row.title as string,
    description: row.description as string,
    capability: row.capability as string | undefined,
    input: row.input_json ? JSON.parse(row.input_json as string) : undefined,
    urgency: row.urgency as PendingSuggestion['urgency'],
    createdAt: row.created_at as number,
    deliveredAt: row.delivered_at as number | null,
  };
}
