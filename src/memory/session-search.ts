import type Database from 'better-sqlite3';
import type { CapabilityBus } from '../bus/capability-bus.js';

export function registerSessionSearchCapability(bus: CapabilityBus, db: Database.Database): void {
  bus.register(
    {
      name: 'session_search',
      description: 'Search across historical conversation sessions by keyword/topic. Returns relevant conversation fragments.',
      dangerLevel: 'safe',
      provider: { type: 'builtin', name: 'memory' },
    },
    async (input) => {
      const { query, excludeSessionId, limit } = input as { query: string; excludeSessionId?: string; limit?: number };
      if (!query || query.length < 2) return { results: [], reason: 'query too short' };

      try {
        const maxResults = limit ?? 5;
        const ftsQuery = query.split(/\s+/).map(w => `"${w}"`).join(' OR ');

        let rows: Array<{ session_id: string; role: string; content: string; rowid: number }>;
        if (excludeSessionId) {
          rows = db.prepare(`
            SELECT c.session_id, c.role, c.content, c.rowid
            FROM conversations c
            JOIN conversations_fts f ON c.rowid = f.rowid
            WHERE conversations_fts MATCH ? AND c.session_id != ?
            ORDER BY rank LIMIT ?
          `).all(ftsQuery, excludeSessionId, maxResults * 3) as any;
        } else {
          rows = db.prepare(`
            SELECT c.session_id, c.role, c.content, c.rowid
            FROM conversations c
            JOIN conversations_fts f ON c.rowid = f.rowid
            WHERE conversations_fts MATCH ?
            ORDER BY rank LIMIT ?
          `).all(ftsQuery, maxResults * 3) as any;
        }

        if (rows.length === 0) return { results: [] };

        // Group by session, take top sessions
        const sessionMap = new Map<string, Array<{ role: string; content: string }>>();
        for (const row of rows) {
          const arr = sessionMap.get(row.session_id) ?? [];
          arr.push({ role: row.role, content: row.content.slice(0, 300) });
          sessionMap.set(row.session_id, arr);
        }

        const results = [...sessionMap.entries()]
          .slice(0, maxResults)
          .map(([sessionId, messages]) => ({
            sessionId,
            fragments: messages.slice(0, 4),
          }));

        return { results };
      } catch {
        return { results: [], error: 'FTS search failed (index may not exist)' };
      }
    },
  );
}
