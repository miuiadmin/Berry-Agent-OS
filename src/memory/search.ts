import { getDb } from './db.js';
import type { KnowledgeEntry } from './knowledge.js';
import { metrics } from '../observability/metrics.js';
import type { EmbeddingProvider } from './embeddings.js';
import { VectorStore } from './vector-store.js';

export interface SearchOptions {
  type?: string;
  limit?: number;
  scope?: string;
  includeDismissed?: boolean;
}

export interface HybridSearchOptions extends SearchOptions {
  semanticWeight?: number;
}

export interface SearchResult extends KnowledgeEntry {
  score: number;
}

export function searchKnowledge(query: string, options?: SearchOptions): SearchResult[] {
  const t0 = Date.now();
  const db = getDb();
  const limit = options?.limit ?? 5;
  const now = Date.now();

  let dismissedFilter = 'AND k.dismissed = 0';
  if (options?.includeDismissed) {
    dismissedFilter = '';
  }

  let scopeFilter = '';
  if (options?.scope) {
    scopeFilter = 'AND k.scope = ?';
  }

  let sql = `
    SELECT k.*, fts.rank AS match_rank
    FROM knowledge_fts fts
    JOIN knowledge k ON k.rowid = fts.rowid
    WHERE knowledge_fts MATCH ?
      ${dismissedFilter}
      ${scopeFilter}
  `;
  const params: unknown[] = [sanitizeFtsQuery(query)];

  if (options?.scope) {
    params.push(options.scope);
  }

  if (options?.type) {
    sql += ' AND k.type = ?';
    params.push(options.type);
  }

  sql += ' LIMIT 50';

  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  const maxRank = Math.max(...rows.map((r) => Math.abs(r.match_rank as number)), 1);

  const scored = rows.map((row) => {
    const confidence = row.confidence as number;
    const importance = row.importance as number;
    const durability = row.durability as number;
    const lastUsed = row.last_used_at as number | null;
    const lastSeen = row.last_seen_at as number | null;
    const matchRank = Math.abs(row.match_rank as number);

    const recencyTime = lastUsed ?? lastSeen ?? (row.updated_at as number);
    const daysSinceUse = recencyTime ? (now - recencyTime) / (1000 * 60 * 60 * 24) : 30;
    const recency = 1 / (1 + daysSinceUse / 30);
    const matchScore = matchRank / maxRank;

    const score = 0.3 * confidence + 0.2 * importance + 0.15 * durability + 0.2 * recency + 0.15 * matchScore;

    return {
      id: row.id as string,
      ownerKey: (row.owner_key as string) ?? 'user:owner',
      type: row.type as KnowledgeEntry['type'],
      summary: row.summary as string,
      detail: (row.detail as string) ?? null,
      scope: row.scope as KnowledgeEntry['scope'],
      evidenceKind: row.evidence_kind as KnowledgeEntry['evidenceKind'],
      source: (row.source as KnowledgeEntry['source']) ?? 'conversation',
      confidence,
      importance,
      durability,
      evidenceCount: row.evidence_count as number,
      provenance: (row.provenance as string) ?? null,
      dismissed: (row.dismissed as number) === 1,
      supersededBy: (row.superseded_by as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastSeenAt: lastSeen ?? (row.updated_at as number),
      lastUsedAt: lastUsed ?? null,
      lastUsedQuery: (row.last_used_query as string) ?? null,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  metrics.counter('memory_search_total').inc({ source: 'fts' });
  metrics.histogram('memory_search_duration_ms').observe(Date.now() - t0, { source: 'fts' });
  metrics.histogram('memory_search_results').observe(results.length, { source: 'fts' });

  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE knowledge SET last_used_at = ?, last_used_query = ? WHERE id IN (${placeholders})`).run(
      now,
      query,
      ...ids,
    );
  }

  return results;
}

function sanitizeFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return '""';

  const tokens: string[] = [];
  for (const segment of cleaned.split(/\s+/)) {
    if (!segment) continue;
    if (segment.length >= 3) {
      tokens.push(`"${segment}"`);
    }
    if (/[一-鿿]/.test(segment) && segment.length > 3) {
      for (let i = 0; i <= segment.length - 3; i++) {
        tokens.push(`"${segment.slice(i, i + 3)}"`);
      }
    }
  }

  if (tokens.length === 0) return '""';
  const unique = [...new Set(tokens)];
  return unique.slice(0, 20).join(' OR ');
}

export function searchHybrid(
  query: string,
  embeddingProvider: EmbeddingProvider,
  vectorStore: VectorStore,
  options?: HybridSearchOptions,
): SearchResult[] {
  const t0 = Date.now();
  const semanticWeight = options?.semanticWeight ?? 0.4;
  const limit = options?.limit ?? 5;

  const bm25Results = searchKnowledge(query, { ...options, limit: 30 });
  if (bm25Results.length === 0) return [];

  let queryEmbedding: number[];
  try {
    const embeddings = embeddingProvider.embed([query]);
    if (embeddings instanceof Promise) {
      return bm25Results.slice(0, limit);
    }
    queryEmbedding = (embeddings as number[][])[0];
  } catch {
    return bm25Results.slice(0, limit);
  }

  const candidateIds = bm25Results.map(r => r.id);
  const vectorResults = vectorStore.search(queryEmbedding, 30, candidateIds);
  const vectorScores = new Map(vectorResults.map(r => [r.id, r.score]));

  const fused = reciprocalRankFusion(bm25Results, vectorScores, semanticWeight);

  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  const results = fused.slice(0, limit).map(f => {
    const entry = bm25Results.find(r => r.id === f.id)!;
    return { ...entry, score: f.fusedScore };
  });

  metrics.counter('memory_search_total').inc({ source: 'hybrid' });
  metrics.histogram('memory_search_duration_ms').observe(Date.now() - t0, { source: 'hybrid' });
  metrics.histogram('memory_search_results').observe(results.length, { source: 'hybrid' });

  return results;
}

export async function searchHybridAsync(
  query: string,
  embeddingProvider: EmbeddingProvider,
  vectorStore: VectorStore,
  options?: HybridSearchOptions,
): Promise<SearchResult[]> {
  const t0 = Date.now();
  const semanticWeight = options?.semanticWeight ?? 0.4;
  const limit = options?.limit ?? 5;

  const bm25Results = searchKnowledge(query, { ...options, limit: 30 });
  if (bm25Results.length === 0) return [];

  let queryEmbedding: number[];
  try {
    const [embedding] = await embeddingProvider.embed([query]);
    queryEmbedding = embedding;
  } catch {
    return bm25Results.slice(0, limit);
  }

  const candidateIds = bm25Results.map(r => r.id);
  const vectorResults = vectorStore.search(queryEmbedding, 30, candidateIds);
  const vectorScores = new Map(vectorResults.map(r => [r.id, r.score]));

  const fused = reciprocalRankFusion(bm25Results, vectorScores, semanticWeight);

  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  const results = fused.slice(0, limit).map(f => {
    const entry = bm25Results.find(r => r.id === f.id)!;
    return { ...entry, score: f.fusedScore };
  });

  metrics.counter('memory_search_total').inc({ source: 'hybrid' });
  metrics.histogram('memory_search_duration_ms').observe(Date.now() - t0, { source: 'hybrid' });
  metrics.histogram('memory_search_results').observe(results.length, { source: 'hybrid' });

  return results;
}

function reciprocalRankFusion(
  bm25Results: SearchResult[],
  vectorScores: Map<string, number>,
  semanticWeight: number,
): Array<{ id: string; fusedScore: number }> {
  const k = 60;
  const bm25Weight = 1 - semanticWeight;
  const allIds = new Set(bm25Results.map(r => r.id));

  const results: Array<{ id: string; fusedScore: number }> = [];

  for (const id of allIds) {
    const bm25Rank = bm25Results.findIndex(r => r.id === id) + 1;
    const bm25Rrf = bm25Rank > 0 ? 1 / (k + bm25Rank) : 0;

    const vectorScore = vectorScores.get(id);
    const vectorRrf = vectorScore !== undefined ? vectorScore : 0;

    const fusedScore = bm25Weight * bm25Rrf + semanticWeight * vectorRrf;
    results.push({ id, fusedScore });
  }

  return results;
}
