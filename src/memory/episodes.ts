import { getDb } from './db.js';
import { genId } from '../utils/id.js';
import { safeJsonParse } from '../utils/safe-json.js';

export type EpisodeEventType = 'user_message' | 'assistant_response' | 'tool_call' | 'memory_extracted' | 'error';

export interface Episode {
  id: string;
  sessionId: string;
  eventType: EpisodeEventType;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export function logEpisode(sessionId: string, eventType: EpisodeEventType, content: string, metadata?: Record<string, unknown>): string {
  const db = getDb();
  const id = genId('ep');
  db.prepare(`
    INSERT INTO episodes (id, session_id, event_type, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, eventType, content, metadata ? JSON.stringify(metadata) : null, Date.now());
  return id;
}

export function getEpisodes(sessionId: string, limit = 50): Episode[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    eventType: row.event_type as EpisodeEventType,
    content: row.content as string,
    metadata: row.metadata ? safeJsonParse<Record<string, unknown>>(row.metadata as string, {}) : undefined,
    createdAt: row.created_at as number,
  };
}
