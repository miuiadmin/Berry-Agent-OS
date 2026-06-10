/**
 * AgentRequestQueue 单元测试 — 验证 per-agent 并发控制队列。
 *
 * 覆盖场景：
 *   1. 基本 enqueue → 立即处理（agent 空闲）
 *   2. 队列深度限制（max 3）
 *   3. FIFO 串行处理
 *   4. complete 后处理下一个
 *   5. 超时拒绝
 *   6. clearForAgent 批量拒绝
 *   7. clearAll 全量清理
 *   8. 多 agent 隔离
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRequestQueue } from '../../kernel/agent-request-queue.js';

describe('AgentRequestQueue', () => {
  let queue: AgentRequestQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new AgentRequestQueue({ maxQueueDepth: 3, maxWaitMs: 5000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 基本入队 ───

  it('空闲 agent 应立即 resolve', async () => {
    const promise = queue.enqueue('learning', {
      fromAgent: 'code',
      requestId: 'req-1',
      resolve: vi.fn(),
      reject: vi.fn(),
    });

    // resolve 由 enqueue 内部的 resolve 调用触发
    await expect(promise).resolves.toBeUndefined();
    expect(queue.isProcessing('learning')).toBe(true);
  });

  // ─── 队列深度限制 ───

  it('队列深度超过限制应立即 reject', async () => {
    // 第一个立即处理（resolve 由 enqueue 内部触发）
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    await p1; // 等待处理

    // 第二个排队（不会立即 resolve，因为 agent 在处理 p1）
    const p2 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });
    // 第三个排队
    const p3 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-3',
      resolve: () => {}, reject: () => {},
    });
    // 第四个排队
    const p4 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-4',
      resolve: () => {}, reject: () => {},
    });
    // 第五个应该被拒绝（深度 3 已满：1 处理 + 3 排队 = 4 总，再加一个超限）
    const p5 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-5',
      resolve: () => {}, reject: () => {},
    });

    await expect(p5).rejects.toThrow('agent_busy');
  });

  // ─── FIFO 串行处理 ───

  it('complete 后应处理下一个排队请求', async () => {
    // 第一个请求
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    await p1;
    expect(queue.isProcessing('learning')).toBe(true);

    // 第二个请求排队
    const p2 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });

    // 完成第一个请求 → 第二个应该开始
    queue.complete('learning');
    await p2;
    expect(queue.isProcessing('learning')).toBe(true);
  });

  // ─── 超时拒绝 ───

  it('等待超时应 reject 并自动出队', async () => {
    // 第一个请求占住 agent
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    await p1;

    // 第二个请求排队
    const p2 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });

    // 快进超过超时时间
    vi.advanceTimersByTime(6000);

    await expect(p2).rejects.toThrow('agent_timeout');
    expect(queue.getQueueDepth('learning')).toBe(0);
  });

  // ─── clearForAgent ───

  it('clearForAgent 应拒绝所有排队请求', async () => {
    // 第一个请求占住
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    await p1;

    // 第二个排队
    const p2 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });

    // agent 崩溃
    queue.clearForAgent('learning', 'crashed');

    await expect(p2).rejects.toThrow('agent_unavailable');
    expect(queue.isProcessing('learning')).toBe(false);
    expect(queue.getQueueDepth('learning')).toBe(0);
  });

  // ─── clearAll ───

  it('clearAll 应清理所有 agent 的队列', async () => {
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    const p2 = queue.enqueue('memory', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });
    await p1;
    await p2;

    queue.clearAll('shutdown');

    expect(queue.getQueueDepth('learning')).toBe(0);
    expect(queue.getQueueDepth('memory')).toBe(0);
  });

  // ─── 多 agent 隔离 ───

  it('不同 agent 的队列应该独立', async () => {
    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    const p2 = queue.enqueue('memory', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });

    // 两个都应该立即处理（不同 agent，各自独立队列）
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    expect(queue.isProcessing('learning')).toBe(true);
    expect(queue.isProcessing('memory')).toBe(true);
  });

  // ─── 查询方法 ───

  it('getQueueDepth 应返回正确的队列深度', async () => {
    expect(queue.getQueueDepth('learning')).toBe(0);

    const p1 = queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-1',
      resolve: () => {}, reject: () => {},
    });
    await p1;
    // 第一个立即处理，不排队
    expect(queue.getQueueDepth('learning')).toBe(0);

    // 第二个排队
    queue.enqueue('learning', {
      fromAgent: 'code', requestId: 'req-2',
      resolve: () => {}, reject: () => {},
    });
    expect(queue.getQueueDepth('learning')).toBe(1);
  });
});
