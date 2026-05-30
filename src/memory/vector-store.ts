import type { Database } from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('vector-store');

export class VectorStore {
  constructor(private db: Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        knowledge_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
  }

  upsert(knowledgeId: string, embedding: number[], model: string): void {
    const blob = Buffer.from(new Float64Array(embedding).buffer);
    this.db.prepare(`
      INSERT INTO knowledge_embeddings (knowledge_id, embedding, model, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model, dimensions = excluded.dimensions
    `).run(knowledgeId, blob, model, embedding.length, Date.now());
  }

  get(knowledgeId: string): number[] | null {
    const row = this.db.prepare(
      'SELECT embedding, dimensions FROM knowledge_embeddings WHERE knowledge_id = ?'
    ).get(knowledgeId) as { embedding: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions));
  }

  search(query: number[], limit: number, candidateIds?: string[]): Array<{ id: string; score: number }> {
    let rows: Array<{ knowledge_id: string; embedding: Buffer; dimensions: number }>;

    if (candidateIds && candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(',');
      rows = this.db.prepare(
        `SELECT knowledge_id, embedding, dimensions FROM knowledge_embeddings WHERE knowledge_id IN (${placeholders})`
      ).all(...candidateIds) as typeof rows;
    } else {
      rows = this.db.prepare(
        'SELECT knowledge_id, embedding, dimensions FROM knowledge_embeddings'
      ).all() as typeof rows;
    }

    const results: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const vec = Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions));
      const score = cosineSimilarity(query, vec);
      results.push({ id: row.knowledge_id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  delete(knowledgeId: string): void {
    this.db.prepare('DELETE FROM knowledge_embeddings WHERE knowledge_id = ?').run(knowledgeId);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM knowledge_embeddings').get() as { cnt: number };
    return row.cnt;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
