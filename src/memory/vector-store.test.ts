import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { VectorStore, cosineSimilarity } from './vector-store.js';
import { TfIdfEmbeddingProvider } from './embeddings.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for different lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('handles zero vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('VectorStore', () => {
  function createStore() {
    const db = new Database(':memory:');
    return new VectorStore(db);
  }

  it('upserts and retrieves embeddings', () => {
    const store = createStore();
    const vec = [0.1, 0.2, 0.3, 0.4];
    store.upsert('k1', vec, 'test-model');

    const retrieved = store.get('k1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(4);
    for (let i = 0; i < vec.length; i++) {
      expect(retrieved![i]).toBeCloseTo(vec[i], 10);
    }
  });

  it('returns null for missing entries', () => {
    const store = createStore();
    expect(store.get('nonexistent')).toBeNull();
  });

  it('searches by cosine similarity', () => {
    const store = createStore();
    store.upsert('a', [1, 0, 0, 0], 'test');
    store.upsert('b', [0.9, 0.1, 0, 0], 'test');
    store.upsert('c', [0, 0, 1, 0], 'test');

    const results = store.search([1, 0, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].id).toBe('b');
  });

  it('filters by candidate IDs', () => {
    const store = createStore();
    store.upsert('a', [1, 0, 0], 'test');
    store.upsert('b', [0.9, 0.1, 0], 'test');
    store.upsert('c', [0, 0, 1], 'test');

    const results = store.search([1, 0, 0], 10, ['b', 'c']);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.id === 'a')).toBeUndefined();
  });

  it('deletes embeddings', () => {
    const store = createStore();
    store.upsert('k1', [1, 2, 3], 'test');
    store.delete('k1');
    expect(store.get('k1')).toBeNull();
    expect(store.count()).toBe(0);
  });
});

describe('TfIdfEmbeddingProvider', () => {
  it('produces normalized embeddings', async () => {
    const provider = new TfIdfEmbeddingProvider(64);
    provider.train([
      'the cat sat on the mat',
      'the dog played in the park',
      'machine learning with neural networks',
    ]);

    const [embedding] = await provider.embed(['cat on the mat']);
    expect(embedding.length).toBe(64);

    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      expect(norm).toBeCloseTo(1, 3);
    }
  });

  it('produces similar embeddings for texts sharing vocabulary', async () => {
    const provider = new TfIdfEmbeddingProvider(64);
    provider.train([
      'TypeScript programming language code',
      'JavaScript programming language code',
      'cooking Italian pasta recipes dinner',
      'database optimization techniques query',
    ]);

    const [tsEmb, jsEmb, cookEmb] = await provider.embed([
      'TypeScript programming language',
      'JavaScript programming language',
      'cooking pasta recipes',
    ]);

    const tsJs = cosineSimilarity(tsEmb, jsEmb);
    const tsCook = cosineSimilarity(tsEmb, cookEmb);
    expect(tsJs).toBeGreaterThan(tsCook);
  });

  it('returns correct dimensions and model name', () => {
    const provider = new TfIdfEmbeddingProvider(128);
    expect(provider.dimensions()).toBe(128);
    expect(provider.modelName()).toBe('tfidf-local');
  });
});
