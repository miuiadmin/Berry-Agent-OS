import { describe, it, expect } from 'vitest';
import { FallbackRouter } from './fallback-router.js';

describe('FallbackRouter', () => {
  it('routes code-related messages to code agent', () => {
    const router = new FallbackRouter();
    const decision = router.route('请帮我修改这个文件的代码');
    expect(decision.intent).toBe('code');
    expect(decision.targetAgent).toBe('code');
  });

  it('routes plugin-related messages to plugin-builder', () => {
    const router = new FallbackRouter();
    const decision = router.route('生成一个新的插件');
    expect(decision.intent).toBe('plugin');
    expect(decision.targetAgent).toBe('plugin-builder');
  });

  it('defaults to chat for unknown messages', () => {
    const router = new FallbackRouter();
    const decision = router.route('你好，今天天气怎么样？');
    expect(decision.intent).toBe('chat');
    expect(decision.targetAgent).toBe('conversation');
  });

  it('uses cached Brain decisions', () => {
    const router = new FallbackRouter();
    router.recordBrainDecision('特殊请求', {
      intent: 'learning',
      targetAgent: 'learning',
      priority: 'normal',
      reason: 'brain decided',
    });
    const decision = router.route('特殊请求');
    expect(decision.intent).toBe('learning');
    expect(decision.targetAgent).toBe('learning');
  });

  it('expires cache entries after TTL', () => {
    const router = new FallbackRouter({ cacheTtlMs: 1 });
    router.recordBrainDecision('过期请求', {
      intent: 'code',
      targetAgent: 'code',
      priority: 'normal',
      reason: 'test',
    });
    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const decision = router.route('过期请求');
    expect(decision.intent).toBe('chat');
  });

  it('handles English code keywords', () => {
    const router = new FallbackRouter();
    const decision = router.route('fix the authentication bug');
    expect(decision.intent).toBe('code');
  });
});
