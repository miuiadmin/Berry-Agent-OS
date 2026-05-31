/**
 * Prompt Cache Layout (§8.14)
 *
 * Strategy: system + last 3 messages get cache breakpoints.
 * Multi-turn saves ~75% input cost.
 *
 * Layout:
 *   [system prompt]     ← breakpoint ① (rarely changes)
 *   [msg 1]...[msg N-3] ← no cache (may be compressed)
 *   [msg N-2]           ← breakpoint ②
 *   [msg N-1]           ← breakpoint ③
 *   [msg N]             ← breakpoint ④ (current user turn)
 *
 * Implementation note:
 * When using Anthropic SDK with cacheControl: { type: 'ephemeral' },
 * the SDK automatically places cache breakpoints on system prompt
 * and recent messages. This module provides explicit marking for
 * backends that need manual breakpoint placement.
 */

export interface CacheBreakpoint {
  index: number;
  type: 'system' | 'recent';
}

export function computeCacheBreakpoints(messageCount: number): CacheBreakpoint[] {
  const breakpoints: CacheBreakpoint[] = [];

  breakpoints.push({ index: -1, type: 'system' });

  if (messageCount >= 3) {
    breakpoints.push({ index: messageCount - 3, type: 'recent' });
  }
  if (messageCount >= 2) {
    breakpoints.push({ index: messageCount - 2, type: 'recent' });
  }
  if (messageCount >= 1) {
    breakpoints.push({ index: messageCount - 1, type: 'recent' });
  }

  return breakpoints;
}

export function shouldEnableCache(provider: string): boolean {
  return provider === 'anthropic';
}
