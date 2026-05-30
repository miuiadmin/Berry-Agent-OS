import { getDb } from './db.js';
import { searchKnowledge, type SearchResult } from './search.js';
import { genId } from '../utils/id.js';
import type { MemoryContextFrame, RecallSource } from '../contracts/memory.js';

export interface ContextBuilderOptions {
  maxRecords?: number;
  maxChars?: number;
  runId?: string;
}

const DEFAULT_MAX_RECORDS = 5;
const DEFAULT_MAX_CHARS = 1200;

export function buildMemoryContext(
  sessionId: string,
  query: string,
  recallSource: RecallSource = 'auto_recall',
  options?: ContextBuilderOptions,
): MemoryContextFrame {
  const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  const results = searchKnowledge(query, { limit: maxRecords + 5 });

  const records: MemoryContextFrame['records'] = [];
  let usedChars = 0;
  let truncated = false;

  for (const r of results) {
    if (records.length >= maxRecords) { truncated = true; break; }
    const text = formatRecord(r);
    if (usedChars + text.length > maxChars) { truncated = true; break; }
    usedChars += text.length;
    records.push({
      id: r.id,
      type: r.type,
      summary: r.summary,
      score: r.score,
      confidence: r.confidence,
      importance: r.importance,
      updatedAt: r.updatedAt,
    });
  }

  let contextText = '';
  if (records.length > 0) {
    const lines = records.map((r) => `- [${r.type}] ${r.summary} (置信度:${r.confidence.toFixed(1)})`);
    contextText = lines.join('\n');
  } else {
    const profileSummary = getConfigValue('profile_summary');
    const activeSummary = getConfigValue('active_summary');
    if (profileSummary || activeSummary) {
      const parts: string[] = [];
      if (profileSummary) parts.push(`用户画像: ${profileSummary}`);
      if (activeSummary) parts.push(`当前关注: ${activeSummary}`);
      contextText = parts.join('\n');
      usedChars = contextText.length;
    }
  }

  const frame: MemoryContextFrame = {
    id: genId('mcf'),
    sessionId,
    runId: options?.runId,
    query,
    recallSource,
    contextText,
    records,
    budget: { maxRecords, maxChars, usedChars, truncated },
  };

  logMemoryAccess(frame);
  return frame;
}

function formatRecord(r: SearchResult): string {
  return `[${r.type}] ${r.summary}`;
}

function getConfigValue(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setConfigValue(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, now);
}

function logMemoryAccess(frame: MemoryContextFrame): void {
  try {
    const db = getDb();
    const runId = frame.runId && runArtifactExists(db, frame.runId) ? frame.runId : null;
    db.prepare(`
      INSERT INTO memory_access_log (id, run_id, session_id, agent_name, recall_source, query, result_ids, scores, context_chars, truncated, created_at)
      VALUES (?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId('mal'),
      runId,
      frame.sessionId,
      frame.recallSource,
      frame.query,
      JSON.stringify(frame.records.map((r) => r.id)),
      JSON.stringify(frame.records.map((r) => ({ id: r.id, score: r.score }))),
      frame.budget.usedChars,
      frame.budget.truncated ? 1 : 0,
      Date.now(),
    );
  } catch {
    // 审计写入失败不阻塞主流程
  }
}

function runArtifactExists(db: ReturnType<typeof getDb>, runId: string): boolean {
  const row = db.prepare(`SELECT 1 AS found FROM run_artifacts WHERE id = ?`).get(runId) as { found: number } | undefined;
  return Boolean(row);
}
