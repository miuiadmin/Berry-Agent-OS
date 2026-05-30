import type { RouteDecision, RoutingIntent } from '../contracts/routing.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('fallback-router');

interface CacheEntry {
  decision: RouteDecision;
  timestamp: number;
}

interface RoutingRule {
  patterns: RegExp[];
  intent: RoutingIntent;
  targetAgent: string;
}

const RULES: RoutingRule[] = [
  {
    patterns: [
      /(?:写|修改|创建|删除|重构|编辑|新建).*(?:代码|文件|函数|类|接口|模块|组件)/,
      /(?:fix|refactor|implement|write|create|edit|delete)\s/i,
      /(?:bug|error|报错|修复)/,
    ],
    intent: 'code',
    targetAgent: 'code',
  },
  {
    patterns: [
      /(?:测试|验证).*(?:技能|skill)/i,
      /skill.*(?:test|validate)/i,
    ],
    intent: 'skill_test',
    targetAgent: 'skill-tester',
  },
  {
    patterns: [
      /(?:生成|创建|修改).*(?:插件|plugin)/i,
      /plugin.*(?:build|create|generate)/i,
    ],
    intent: 'plugin',
    targetAgent: 'plugin-builder',
  },
];

const DEFAULT_CHAT_DECISION: RouteDecision = {
  intent: 'chat',
  targetAgent: 'conversation',
  priority: 'normal',
  reason: 'fallback: default chat route',
};

export class FallbackRouter {
  private cache = new Map<string, CacheEntry>();
  private maxCacheSize: number;
  private cacheTtlMs: number;

  constructor(opts?: { maxCacheSize?: number; cacheTtlMs?: number }) {
    this.maxCacheSize = opts?.maxCacheSize ?? 64;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 300_000;
  }

  route(message: string): RouteDecision {
    const cached = this.getCached(message);
    if (cached) {
      logger.debug({ intent: cached.intent }, '使用缓存路由决策');
      return cached;
    }

    for (const rule of RULES) {
      if (rule.patterns.some((p) => p.test(message))) {
        const decision: RouteDecision = {
          intent: rule.intent,
          targetAgent: rule.targetAgent,
          priority: 'normal',
          reason: `fallback: keyword match → ${rule.intent}`,
        };
        logger.info({ intent: rule.intent }, '降级路由: 关键词匹配');
        return decision;
      }
    }

    return DEFAULT_CHAT_DECISION;
  }

  recordBrainDecision(message: string, decision: RouteDecision): void {
    const key = this.normalizeKey(message);
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = this.findOldest();
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { decision, timestamp: Date.now() });
  }

  private getCached(message: string): RouteDecision | null {
    const key = this.normalizeKey(message);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp <= this.cacheTtlMs) {
      return entry.decision;
    }
    if (entry) {
      this.cache.delete(key);
    }

    // Fuzzy match: check token overlap with cached keys
    const tokens = new Set(key.split(/\s+/).filter(t => t.length > 2));
    if (tokens.size < 2) return null;

    let bestMatch: CacheEntry | null = null;
    let bestScore = 0;
    for (const [cachedKey, cachedEntry] of this.cache) {
      if (Date.now() - cachedEntry.timestamp > this.cacheTtlMs) continue;
      const cachedTokens = cachedKey.split(/\s+/).filter(t => t.length > 2);
      const overlap = cachedTokens.filter(t => tokens.has(t)).length;
      const score = overlap / Math.max(tokens.size, cachedTokens.length);
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestMatch = cachedEntry;
      }
    }

    return bestMatch?.decision ?? null;
  }

  private normalizeKey(message: string): string {
    return message.trim().toLowerCase().slice(0, 100);
  }

  private findOldest(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
