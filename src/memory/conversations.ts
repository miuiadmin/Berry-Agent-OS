import { getDb } from './db.js';
import { genId } from '../utils/id.js';

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: number;
}

export function saveMessage(sessionId: string, role: 'user' | 'assistant', content: string, reasoning?: string): string {
  const db = getDb();
  const id = genId('msg');
  db.prepare(`
    INSERT INTO conversations (id, session_id, role, content, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, role, content, reasoning ?? null, Date.now());
  return id;
}

export function getHistory(sessionId: string, limit = 20): ConversationMessage[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
  ).all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

function rowToMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    reasoning: (row.reasoning as string) || undefined,
    createdAt: row.created_at as number,
  };
}
