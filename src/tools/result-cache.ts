import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('tool-result-cache');

interface CacheEntry {
  result: unknown;
  expiresAt: number;
}

interface CacheConfig {
  maxSize: number;
  defaultTtlMs: number;
}

const DEFAULT_CONFIG: CacheConfig = {
  maxSize: 200,
  defaultTtlMs: 300000,
};

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      metrics.counter('tool_cache_total').inc({ result: 'miss' });
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromOrder(key);
      metrics.counter('tool_cache_total').inc({ result: 'expired' });
      return undefined;
    }

    this.touchOrder(key);
    metrics.counter('tool_cache_total').inc({ result: 'hit' });
    return entry.result as T;
  }

  set(key: string, result: unknown, ttlMs?: number): void {
    if (this.cache.size >= this.config.maxSize) {
      this.evict();
    }

    this.cache.set(key, {
      result,
      expiresAt: Date.now() + (ttlMs ?? this.config.defaultTtlMs),
    });
    this.touchOrder(key);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.removeFromOrder(key);
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        this.removeFromOrder(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }

  private evict(): void {
    while (this.cache.size >= this.config.maxSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      this.cache.delete(oldest);
    }
  }

  private touchOrder(key: string): void {
    this.removeFromOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) this.accessOrder.splice(idx, 1);
  }
}

export function makeCacheKey(toolName: string, input: unknown): string {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return `${toolName}:${simpleHash(str)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return (hash >>> 0).toString(36);
}
