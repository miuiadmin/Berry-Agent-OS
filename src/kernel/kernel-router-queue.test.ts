/**
 * 13.0 §4.4.1: AgentRequestQueue dialogue 路径接入测试。
 *
 * 验证 dialogue 路径的 sendMessage 经过 per-target 串行化：
 * 同一 target 的多个请求排队，不会并发处理。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRequestQueue } from './agent-request-queue.js';
import { initEventBus } from './event-bus.js';

beforeEach(() => {
  initEventBus();
});

describe('AgentRequestQueue §4.4.1 per-target 串行化', () => {
  it('同一 target 的多个请求串行处理（不并发）', async () => {
    const queue = new AgentRequestQueue();
    const order: string[] = [];

    // 模拟 dialogue 路径：enqueue → 处理 → complete
    async function send(target: string, reqId: string, work: () => Promise<void>) {
      await queue.enqueue(target, { fromAgent: 'caller', requestId: reqId });
      try {
        await work();
      } finally {
        queue.complete(target);
      }
    }

    const p1 = send('memory', 'r1', async () => {
      order.push('r1-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('r1-end');
    });
    const p2 = send('memory', 'r2', async () => {
      order.push('r2-start');
      order.push('r2-end');
    });

    await Promise.all([p1, p2]);

    // r1 必须在 r2 开始前结束（串行）
    expect(order).toEqual(['r1-start', 'r1-end', 'r2-start', 'r2-end']);
  });

  it('队列深度上限 3，超出立即拒绝', async () => {
    const queue = new AgentRequestQueue();
    // r1 进入处理（enqueue 在轮到时 resolve，r1 立即处理）
    await queue.enqueue('target', { fromAgent: 'a', requestId: 'r1' });
    // r2/r3/r4 排队（不 await，否则会挂起直到 r1 完成）— 填满队列深度 3
    const p2 = queue.enqueue('target', { fromAgent: 'a', requestId: 'r2' });
    const p3 = queue.enqueue('target', { fromAgent: 'a', requestId: 'r3' });
    const p4 = queue.enqueue('target', { fromAgent: 'a', requestId: 'r4' });

    // 第 5 个应被立即拒绝（queue.length=3 >= maxQueueDepth=3），不进队列
    await expect(queue.enqueue('target', { fromAgent: 'a', requestId: 'r5' })).rejects.toThrow('agent_busy');

    // 自然排空队列：完成 r1 → r2 开始 → ... → 完成 r4
    // 避免 clearForAgent 漏清 processing entry 的 30s 定时器
    queue.complete('target'); // 释放 r1，r2 开始处理
    await p2;                  // r2 已 resolve
    queue.complete('target'); // 释放 r2，r3 开始处理
    await p3;                  // r3 已 resolve
    queue.complete('target'); // 释放 r3，r4 开始处理
    await p4;                  // r4 已 resolve
    queue.complete('target'); // 释放 r4
  });

  it('不同 target 并发不受彼此阻塞', async () => {
    const queue = new AgentRequestQueue();
    let memDone = false;
    let codeDone = false;

    const memP = queue.enqueue('memory', { fromAgent: 'a', requestId: 'r1' }).then(async () => {
      await new Promise((r) => setTimeout(r, 30));
      memDone = true;
      queue.complete('memory');
    });
    const codeP = queue.enqueue('code', { fromAgent: 'a', requestId: 'r2' }).then(() => {
      // code 不应被 memory 阻塞
      codeDone = true;
      queue.complete('code');
    });

    await Promise.all([memP, codeP]);
    expect(memDone).toBe(true);
    expect(codeDone).toBe(true);
  });
});
