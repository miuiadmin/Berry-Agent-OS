import { getDb } from './db.js';
import { genId } from '../utils/id.js';
import type {
  AddKnowledgeInput,
  EvidenceKind,
  KnowledgeEntry,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeType,
} from '../contracts/memory.js';

export type {
  AddKnowledgeInput,
  EvidenceKind,
  KnowledgeEntry,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeType,
};

export function addKnowledge(input: AddKnowledgeInput): KnowledgeEntry {
  const db = getDb();
  const now = Date.now();
  const confidence = input.confidence ?? 0.7;

  const ownerKey = input.ownerKey ?? 'user:owner';

  // 事务保护：防止 SELECT→INSERT/UPDATE 竞态 + 确保 FTS 触发器一致
  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, evidence_count, confidence FROM knowledge WHERE owner_key = ? AND type = ? AND summary = ? AND dismissed = 0 ORDER BY updated_at DESC LIMIT 1`,
    ).get(ownerKey, input.type, input.summary) as { id: string; evidence_count: number; confidence: number } | undefined;

    if (existing) {
      const newConfidence = Math.min(1, (existing.confidence + confidence) / 2 + 0.05);
      const sets = ['confidence = ?', 'evidence_count = evidence_count + 1', 'updated_at = ?', 'last_seen_at = ?'];
      const values: unknown[] = [newConfidence, now, now];

      if (input.detail) {
        sets.push('detail = ?');
        values.push(input.detail);
      }
      if (input.evidenceKind === 'direct') {
        sets.push("evidence_kind = 'direct'");
      }
      if (input.source) {
        sets.push('source = ?');
        values.push(input.source);
      }
      if (input.provenance) {
        sets.push('provenance = ?');
        values.push(input.provenance);
      }

      values.push(existing.id);
      db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return getKnowledge(existing.id)!;
    }

    const id = genId('kn');
    db.prepare(`
      INSERT INTO knowledge (
        id, owner_key, type, summary, detail, scope, evidence_kind, source,
        confidence, importance, durability, evidence_count, provenance,
        dismissed, created_at, updated_at, last_seen_at, last_used_at, last_used_query
      )
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, NULL, NULL)
    `).run(
      id,
      ownerKey,
      input.type,
      input.summary,
      input.detail ?? null,
      input.evidenceKind ?? 'inferred',
      input.source ?? 'conversation',
      confidence,
      input.importance ?? 0.5,
      input.durability ?? 0.5,
      input.provenance ?? null,
      now, now, now,
    );

    return getKnowledge(id)!;
  })();
}

export function getKnowledge(id: string): KnowledgeEntry | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToEntry(row);
}

export interface UpdateKnowledgeInput {
  summary?: string;
  detail?: string;
  confidence?: number;
  importance?: number;
  durability?: number;
  scope?: KnowledgeScope;
  dismissed?: boolean;
}

export function updateKnowledge(id: string, updates: UpdateKnowledgeInput): void {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary); }
  if (updates.detail !== undefined) { sets.push('detail = ?'); values.push(updates.detail); }
  if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
  if (updates.importance !== undefined) { sets.push('importance = ?'); values.push(updates.importance); }
  if (updates.durability !== undefined) { sets.push('durability = ?'); values.push(updates.durability); }
  if (updates.scope !== undefined) { sets.push('scope = ?'); values.push(updates.scope); }
  if (updates.dismissed !== undefined) { sets.push('dismissed = ?'); values.push(updates.dismissed ? 1 : 0); }

  values.push(id);
  db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function dismissKnowledge(id: string): void {
  updateKnowledge(id, { dismissed: true });
}

export function listKnowledge(filters?: { type?: KnowledgeType; scope?: KnowledgeScope; dismissed?: boolean }): KnowledgeEntry[] {
  const db = getDb();
  let sql = 'SELECT * FROM knowledge WHERE 1=1';
  const params: unknown[] = [];

  if (filters?.type) { sql += ' AND type = ?'; params.push(filters.type); }
  if (filters?.scope) { sql += ' AND scope = ?'; params.push(filters.scope); }
  if (filters?.dismissed !== undefined) {
    sql += ' AND dismissed = ?';
    params.push(filters.dismissed ? 1 : 0);
  } else {
    sql += ' AND dismissed = 0';
  }

  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function promoteKnowledge(): number {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(
    `UPDATE knowledge SET scope = 'durable', updated_at = ? WHERE scope = 'active' AND dismissed = 0 AND evidence_count >= 3 AND confidence >= 0.8 AND evidence_kind IN ('direct','manual')`,
  ).run(now);
  return result.changes;
}

export function pruneKnowledge(): number {
  const db = getDb();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const result = db.prepare(
    `UPDATE knowledge SET dismissed = 1, updated_at = ? WHERE scope = 'active' AND dismissed = 0 AND importance < 0.3 AND confidence < 0.5 AND last_seen_at < ?`,
  ).run(now, thirtyDaysAgo);
  return result.changes;
}

export function supersedeKnowledge(oldId: string, newId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`UPDATE knowledge SET dismissed = 1, superseded_by = ?, updated_at = ? WHERE id = ?`).run(newId, now, oldId);
}

function rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: row.id as string,
    ownerKey: (row.owner_key as string) ?? 'user:owner',
    type: row.type as KnowledgeType,
    summary: row.summary as string,
    detail: (row.detail as string) ?? null,
    scope: row.scope as KnowledgeScope,
    evidenceKind: row.evidence_kind as EvidenceKind,
    source: (row.source as KnowledgeSource) ?? 'conversation',
    confidence: row.confidence as number,
    importance: row.importance as number,
    durability: row.durability as number,
    evidenceCount: row.evidence_count as number,
    provenance: (row.provenance as string) ?? null,
    dismissed: (row.dismissed as number) === 1,
    supersededBy: (row.superseded_by as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastSeenAt: (row.last_seen_at as number) ?? (row.updated_at as number),
    lastUsedAt: (row.last_used_at as number) ?? null,
    lastUsedQuery: (row.last_used_query as string) ?? null,
  };
}
