/**
 * Topic 订阅权限矩阵单元测试（§5.3.2 — per-agent 权限矩阵）。
 */
import { describe, it, expect } from 'vitest';
import { gateTopicSubscribe, listTopicPermissions, registerTopicPermission } from './topic-permissions.js';

describe('gateTopicSubscribe — per-agent 权限矩阵', () => {
  // ─── 公共 topic（canSubscribe: ['*']）───

  it('允许所有 agent 订阅公共 topic', () => {
    expect(gateTopicSubscribe('code', 'topic:tool-events')).toBe(true);
    expect(gateTopicSubscribe('learning', 'topic:agent-chats')).toBe(true);
    expect(gateTopicSubscribe('conversation', 'topic:task-progress')).toBe(true);
    expect(gateTopicSubscribe('skills', 'topic:mission-events')).toBe(true);
  });

  // ─── Brain 独占 topic ───

  it('仅 Brain 可订阅 topic:brain-internal', () => {
    expect(gateTopicSubscribe('brain', 'topic:brain-internal')).toBe(true);
    expect(gateTopicSubscribe('code', 'topic:brain-internal')).toBe(false);
    expect(gateTopicSubscribe('kernel', 'topic:brain-internal')).toBe(false);
  });

  it('通配符 brain-internal.* 仅 Brain 匹配', () => {
    expect(gateTopicSubscribe('brain', 'topic:brain-internal.checkpoint')).toBe(true);
    expect(gateTopicSubscribe('brain', 'topic:brain-internal.review-result')).toBe(true);
    expect(gateTopicSubscribe('code', 'topic:brain-internal.checkpoint')).toBe(false);
    expect(gateTopicSubscribe('brain', 'topic:brain-internal.drift-signal.detailed')).toBe(true);
  });

  // ─── Brain + Kernel 共享 topic ───

  it('topic:user-interactions 仅 Brain/Kernel 可订阅', () => {
    expect(gateTopicSubscribe('brain', 'topic:user-interactions')).toBe(true);
    expect(gateTopicSubscribe('kernel', 'topic:user-interactions')).toBe(true);
    expect(gateTopicSubscribe('code', 'topic:user-interactions')).toBe(false);
  });

  it('topic:permission-flows 仅 Brain/Kernel 可订阅', () => {
    expect(gateTopicSubscribe('brain', 'topic:permission-flows')).toBe(true);
    expect(gateTopicSubscribe('kernel', 'topic:permission-flows')).toBe(true);
    expect(gateTopicSubscribe('conversation', 'topic:permission-flows')).toBe(false);
  });

  // ─── Kernel 独占 topic ───

  it('topic:kernel-private 仅 Kernel 可订阅', () => {
    expect(gateTopicSubscribe('kernel', 'topic:kernel-private')).toBe(true);
    expect(gateTopicSubscribe('brain', 'topic:kernel-private')).toBe(false);
    expect(gateTopicSubscribe('code', 'topic:kernel-private')).toBe(false);
  });

  it('通配符 kernel-private.* 仅 Kernel 匹配', () => {
    expect(gateTopicSubscribe('kernel', 'topic:kernel-private.budget-alert')).toBe(true);
    expect(gateTopicSubscribe('code', 'topic:kernel-private.budget-alert')).toBe(false);
  });

  it('topic:security-audit 仅 Kernel 可订阅', () => {
    expect(gateTopicSubscribe('kernel', 'topic:security-audit')).toBe(true);
    expect(gateTopicSubscribe('brain', 'topic:security-audit')).toBe(false);
  });

  // ─── fail-closed：未注册的 topic 一律拒绝 ───

  it('未注册的 topic 一律拒绝（fail-closed）', () => {
    expect(gateTopicSubscribe('code', 'topic:unknown-topic')).toBe(false);
    expect(gateTopicSubscribe('brain', 'topic:unknown-topic')).toBe(false);
  });

  it('空 topic 拒绝', () => {
    expect(gateTopicSubscribe('code', '')).toBe(false);
  });

  // ─── 相似但不同的 topic 不误匹配 ───

  it('topic:brain-internals 不在矩阵中，被拒绝（fail-closed）', () => {
    // 与 topic:brain-internal 不同，这是一个独立的 topic 名
    // 新模型下未注册 = 拒绝
    expect(gateTopicSubscribe('code', 'topic:brain-internals')).toBe(false);
    // brain-internal.* 通配符不会匹配 brain-internals（前缀不同）
    expect(gateTopicSubscribe('code', 'topic:brain-internal.foo')).toBe(false);
  });
});

describe('listTopicPermissions', () => {
  it('返回非空权限矩阵', () => {
    const perms = listTopicPermissions();
    expect(Object.keys(perms).length).toBeGreaterThan(0);
    expect(perms['topic:brain-internal']).toBeDefined();
    expect(perms['topic:brain-internal'].canSubscribe).toEqual(['brain']);
  });
});

describe('registerTopicPermission', () => {
  it('动态注册新 topic 权限后可被 gate 通过', () => {
    // 注册一个自定义 topic
    registerTopicPermission('topic:plugin-custom', { canSubscribe: ['*'] });
    expect(gateTopicSubscribe('code', 'topic:plugin-custom')).toBe(true);
    expect(gateTopicSubscribe('learning', 'topic:plugin-custom')).toBe(true);
  });

  it('动态注册受限 topic 后仅指定 agent 可订阅', () => {
    registerTopicPermission('topic:plugin-restricted', { canSubscribe: ['code', 'skills'] });
    expect(gateTopicSubscribe('code', 'topic:plugin-restricted')).toBe(true);
    expect(gateTopicSubscribe('skills', 'topic:plugin-restricted')).toBe(true);
    expect(gateTopicSubscribe('brain', 'topic:plugin-restricted')).toBe(false);
  });
});
