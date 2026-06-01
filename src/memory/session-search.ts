import type Database from 'better-sqlite3';
import type { CapabilityBus } from '../bus/capability-bus.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('session-search');

interface SessionSearchInput {
  query: string;
  excludeSessionId?: string;
  limit?: number;
  offset?: number;
  dateFrom?: number;
  dateTo?: number;
  agentFilter?: string;
}

const RESULT_CACHE = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_SIZE = 100;

export function registerSessionSearchCapability(bus: CapabilityBus, db: Database.Database): void {
  bus.register(
    {
      name: 'session_search',
      description: 'Search across historical conversation sessions by keyword/topic. Supports pagination (offset/limit), date range (dateFrom/dateTo as epoch ms), and agent filtering.',
      dangerLevel: 'safe',
      provider: { type: 'builtin', name: 'memory' },
    },
    async (input) => {
      const { query, excludeSessionId, limit, offset, dateFrom, dateTo, agentFilter } = input as SessionSearchInput;
      if (!query || query.length < 2) return { results: [], total: 0, reason: 'query too short' };

      const cacheKey = JSON.stringify({ query, excludeSessionId, limit, offset, dateFrom, dateTo, agentFilter });
      const cached = RESULT_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.data;

      try {
        const maxResults = Math.min(limit ?? 10, 20);
        const skipResults = offset ?? 0;
        const ftsQuery = query.split(/\s+/).filter(w => w.length > 0).map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
        if (!ftsQuery) return { results: [], total: 0 };

        const conditions: string[] = ['conversations_fts MATCH ?'];
        const params: unknown[] = [ftsQuery];

        if (excludeSessionId) {
          conditions.push('c.session_id != ?');
          params.push(excludeSessionId);
        }
        if (dateFrom) {
          conditions.push('c.created_at >= ?');
          params.push(dateFrom);
        }
        if (dateTo) {
          conditions.push('c.created_at <= ?');
          params.push(dateTo);
        }

        const whereClause = conditions.join(' AND ');
        const fetchLimit = (maxResults + skipResults) * 4;
        params.push(fetchLimit);

        const rows = db.prepare(`
          SELECT c.session_id, c.role, c.content, c.created_at, rank
          FROM conversations c
          JOIN conversations_fts f ON c.rowid = f.rowid
          WHERE ${whereClause}
          ORDER BY rank, c.created_at DESC
          LIMIT ?
        `).all(...params) as Array<{ session_id: string; role: string; content: string; created_at: number }>;

        if (rows.length === 0) return { results: [], total: 0 };

        const sessionMap = new Map<string, { fragments: Array<{ role: string; content: string }>; latestAt: number; matchCount: number }>();
        for (const row of rows) {
          const entry = sessionMap.get(row.session_id) ?? { fragments: [], latestAt: 0, matchCount: 0 };
          entry.matchCount++;
          if (row.created_at > entry.latestAt) entry.latestAt = row.created_at;
          if (entry.fragments.length < 4) {
            entry.fragments.push({ role: row.role, content: row.content.slice(0, 300) });
          }
          sessionMap.set(row.session_id, entry);
        }

        // Sort: more matches first, then recency
        const sorted = [...sessionMap.entries()]
          .sort((a, b) => b[1].matchCount - a[1].matchCount || b[1].latestAt - a[1].latestAt);

        const total = sorted.length;
        const paged = sorted.slice(skipResults, skipResults + maxResults);

        const results = paged.map(([sessionId, data]) => ({
          sessionId,
          fragments: data.fragments,
          matchCount: data.matchCount,
          latestAt: data.latestAt,
        }));

        const response = { results, total, offset: skipResults, limit: maxResults };

        if (RESULT_CACHE.size >= MAX_CACHE_SIZE) {
          const oldest = [...RESULT_CACHE.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
          if (oldest) RESULT_CACHE.delete(oldest[0]);
        }
        RESULT_CACHE.set(cacheKey, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });

        return response;
      } catch {
        return { results: [], total: 0, error: 'FTS search failed (index may not exist)' };
      }
    },
  );
}
