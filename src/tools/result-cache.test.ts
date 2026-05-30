import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolResultCache, makeCacheKey } from './result-cache.js';

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = new ToolResultCache({ maxSize: 5, defaultTtlMs: 10000 });
  });

  it('stores and retrieves values', () => {
    cache.set('k1', { data: 'hello' });
    expect(cache.get('k1')).toEqual({ data: 'hello' });
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('evicts oldest entries when at capacity', () => {
    for (let i = 0; i < 6; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.size).toBe(5);
    expect(cache.get('k0')).toBeUndefined(); // evicted
    expect(cache.get('k5')).toBe(5);
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    cache.set('k1', 'value', 1000);

    expect(cache.get('k1')).toBe('value');

    vi.advanceTimersByTime(1500);
    expect(cache.get('k1')).toBeUndefined();

    vi.useRealTimers();
  });

  it('invalidates by exact key', () => {
    cache.set('tool:abc', 'val');
    cache.invalidate('tool:abc');
    expect(cache.get('tool:abc')).toBeUndefined();
  });

  it('invalidates by prefix', () => {
    cache.set('read_file:a', 1);
    cache.set('read_file:b', 2);
    cache.set('write_file:c', 3);

    cache.invalidateByPrefix('read_file:');
    expect(cache.get('read_file:a')).toBeUndefined();
    expect(cache.get('read_file:b')).toBeUndefined();
    expect(cache.get('write_file:c')).toBe(3);
  });

  it('LRU: recently accessed items survive eviction', () => {
    for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);

    // Access k0 to make it recent
    cache.get('k0');

    // Add one more to trigger eviction
    cache.set('k5', 5);

    expect(cache.get('k0')).toBe(0); // survived (recently accessed)
    expect(cache.get('k1')).toBeUndefined(); // evicted (oldest not accessed)
  });
});

describe('makeCacheKey', () => {
  it('produces consistent keys for same input', () => {
    const k1 = makeCacheKey('read_file', { path: '/tmp/a.txt' });
    const k2 = makeCacheKey('read_file', { path: '/tmp/a.txt' });
    expect(k1).toBe(k2);
  });

  it('produces different keys for different inputs', () => {
    const k1 = makeCacheKey('read_file', { path: '/tmp/a.txt' });
    const k2 = makeCacheKey('read_file', { path: '/tmp/b.txt' });
    expect(k1).not.toBe(k2);
  });

  it('includes tool name in key', () => {
    const k1 = makeCacheKey('tool_a', 'input');
    const k2 = makeCacheKey('tool_b', 'input');
    expect(k1).not.toBe(k2);
  });
});
