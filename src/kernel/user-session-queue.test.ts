/**
 * UserSessionQueue 单元测试（§13.5）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { UserSessionQueue, resetUserSessionQueue } from './user-session-queue.js';
import { initEventBus, resetEventBus } from './event-bus.js';
import { EventBus } from '../contracts/infrastructure.js';

function makeBus(): EventBus {
  return {
    emit: () => {},
    on: () => () => {},
    off: () => {},
    once: () => {},
    removeAllListeners: () => {},
    listenerCount: () => 0,
  } as unknown as EventBus;
}

describe('UserSessionQueue', () => {
  let queue: UserSessionQueue;

  beforeEach(() => {
    resetUserSessionQueue();
    initEventBus();
    queue = new UserSessionQueue({ maxQueueDepth: 3, queueTimeoutMs: 5_000 });
  });

  it('入队返回位置', () => {
    expect(queue.enqueue('user1', 'c1')).toBe(0);
    expect(queue.enqueue('user1', 'c2')).toBe(1);
    expect(queue.enqueue('user1', 'c3')).toBe(2);
  });

  it('队列满返回 -1', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user1', 'c2');
    queue.enqueue('user1', 'c3');
    expect(queue.enqueue('user1', 'c4')).toBe(-1);
  });

  it('不同 user 队列独立', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user2', 'c2');
    expect(queue.getQueueDepth('user1')).toBe(1);
    expect(queue.getQueueDepth('user2')).toBe(1);
  });

  it('dequeue 取出头部', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user1', 'c2');
    const head = queue.dequeue('user1');
    expect(head?.correlationId).toBe('c1');
    expect(queue.getQueueDepth('user1')).toBe(1);
  });

  it('空队列 dequeue 返回 null', () => {
    expect(queue.dequeue('user1')).toBeNull();
  });

  it('clearForUser 清空指定 user 队列', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user1', 'c2');
    queue.enqueue('user2', 'c3');
    const cleared = queue.clearForUser('user1', 'session done');
    expect(cleared).toBe(2);
    expect(queue.getQueueDepth('user1')).toBe(0);
    expect(queue.getQueueDepth('user2')).toBe(1);
  });

  it('listQueued 返回当前所有等待项', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user1', 'c2');
    const items = queue.listQueued('user1');
    expect(items).toHaveLength(2);
    expect(items[0].correlationId).toBe('c1');
  });

  it('listAllUserIds 列出所有有队列的 user', () => {
    queue.enqueue('user1', 'c1');
    queue.enqueue('user2', 'c2');
    queue.enqueue('user3', 'c3');
    const users = queue.listAllUserIds();
    expect(users.sort()).toEqual(['user1', 'user2', 'user3']);
  });

  it('dequeue 后 queue 为空时清理 map entry', () => {
    queue.enqueue('user1', 'c1');
    queue.dequeue('user1');
    expect(queue.listAllUserIds()).not.toContain('user1');
  });
});