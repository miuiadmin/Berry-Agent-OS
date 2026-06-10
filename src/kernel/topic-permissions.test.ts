/**
 * Topic 订阅权限矩阵单元测试（§5.3.2）。
 */
import { describe, it, expect } from 'vitest';
import { gateTopicSubscribe, listForbiddenTopics } from './topic-permissions.js';

describe('gateTopicSubscribe', () => {
  it('允许订阅普通 topic', () => {
    expect(gateTopicSubscribe('code', 'topic:user-events')).toBe(true);
    expect(gateTopicSubscribe('learning', 'topic:skills-updated')).toBe(true);
    expect(gateTopicSubscribe('any-agent', 'topic:custom-events')).toBe(true);
  });

  it('禁止订阅 topic:brain-internal', () => {
    expect(gateTopicSubscribe('code', 'topic:brain-internal')).toBe(false);
    expect(gateTopicSubscribe('conversation', 'topic:brain-internal')).toBe(false);
  });

  it('禁止订阅 topic:brain-internal.*（通配符）', () => {
    expect(gateTopicSubscribe('code', 'topic:brain-internal.checkpoint')).toBe(false);
    expect(gateTopicSubscribe('learning', 'topic:brain-internal.review-result')).toBe(false);
    expect(gateTopicSubscribe('code', 'topic:brain-internal.drift-signal.detailed')).toBe(false);
  });

  it('禁止订阅 topic:kernel-private', () => {
    expect(gateTopicSubscribe('code', 'topic:kernel-private')).toBe(false);
    expect(gateTopicSubscribe('code', 'topic:kernel-private.budget-alert')).toBe(false);
  });

  it('空 topic 拒绝', () => {
    expect(gateTopicSubscribe('code', '')).toBe(false);
  });

  it('相似但非禁的 topic 允许（如 topic:brain-internals 包含 brain-internal）', () => {
    // topic:brain-internals 不会被 topic:brain-internal 命中（无通配符）
    expect(gateTopicSubscribe('code', 'topic:brain-internals')).toBe(true);
    // 但 topic:brain-internal.* 会命中（通配符）
    expect(gateTopicSubscribe('code', 'topic:brain-internal.foo')).toBe(false);
  });
});

describe('listForbiddenTopics', () => {
  it('返回非空禁列', () => {
    const list = listForbiddenTopics();
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain('topic:brain-internal');
  });
});