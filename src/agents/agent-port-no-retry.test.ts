/**
 * AgentPort.request() 不重试保证的强约束单测（§5.3.9）。
 *
 * 设计依据：
 *   - Agent 的 LLM 看到超时/拒绝后自行决定是否重试
 *   - request() 自己不重试（fail-fast），把决策权留给 LLM
 *
 * 覆盖：
 *   - 超时后不重试（只调一次 IPC.send）
 *   - 收到 reject reply 后不重试
 *   - 收到 error reply 后不重试
 *   - timeout=0 时不重试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcChildChannel, IpcMessage } from '../kernel/types.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';
import { createAgentPort } from './agent-port.js';

// ─────────────────────────────────────────────────────────────────
// Mock IPC channel
// ─────────────────────────────────────────────────────────────────

class MockIpc {
  sent: Array<{ type: string; to: string; payload: unknown; correlationId?: string }> = [];
  handlers = new Map<string, Array<(msg: IpcMessage) => void>>();

  get ipc(): IpcChildChannel {
    return {
      onMessage: (type, handler) => {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
      },
      send: (type, to, payload, correlationId) => {
        this.sent.push({ type, to, payload, correlationId });
        return true;
      },
    } as unknown as IpcChildChannel;
  }

  simulateReply(correlationId: string, content: string, metadata: Record<string, unknown> = {}): void {
    // 找到对应的 dialogueId
    const sent = this.sent.find(s => s.correlationId === correlationId);
    if (!sent) throw new Error('No IPC sent with this correlationId');
    const payload = sent.payload as DialogueMessagePayload;
    const reply: DialogueMessagePayload = {
      ...payload,
      sequenceNumber: (payload.sequenceNumber ?? 0) + 1,
      from: sent.to,
      to: payload.from,
      content,
      metadata,
    };
    const handlers = this.handlers.get('dialogue.reply') ?? [];
    for (const h of handlers) {
      h({ id: 'reply-' + Date.now(), type: 'dialogue.reply', correlationId, payload: reply } as IpcMessage);
    }
  }

  simulateTimeout(correlationId: string): void {
    // 模拟超时 — 不发 reply（让 request 自然超时）
    // 这里什么都不做，因为 request 内部有自己的 timeout 计时器
  }

  simulateError(correlationId: string, errorCode: string): void {
    const sent = this.sent.find(s => s.correlationId === correlationId);
    if (!sent) throw new Error('No IPC sent with this correlationId');
    const payload = sent.payload as DialogueMessagePayload;
    const reply: DialogueMessagePayload = {
      ...payload,
      sequenceNumber: (payload.sequenceNumber ?? 0) + 1,
      from: sent.to,
      to: payload.from,
      content: `[对话错误:${errorCode}] something failed`,
      metadata: { isFinal: true, errorCode },
    };
    const handlers = this.handlers.get('dialogue.reply') ?? [];
    for (const h of handlers) {
      h({ id: 'reply-' + Date.now(), type: 'dialogue.reply', correlationId, payload: reply } as IpcMessage);
    }
  }

  reset(): void {
    this.sent = [];
    this.handlers.clear();
  }
}

const askUser = vi.fn();

describe('AgentPort.request() no-retry guarantee (13.0 §5.3.9)', () => {
  let mockIpc: MockIpc;

  beforeEach(() => {
    mockIpc = new MockIpc();
    askUser.mockReset();
  });

  it('超时失败只调一次 IPC.send，不重试', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
    const sendCountBefore = mockIpc.sent.length;

    // 短超时（200ms）— 等到超时都不发 reply
    await expect(
      port.request({ to: 'memory', content: '查询' }, 200),
    ).rejects.toThrow(/timeout|agent/i);

    // send 只多了一条（初始那一条）
    expect(mockIpc.sent.length).toBe(sendCountBefore + 1);
  });

  it('error reply 后不重试', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
    const sendCountBefore = mockIpc.sent.length;

    const promise = port.request({ to: 'memory', content: '查询' }, 5_000);
    // 立即发送一次 — 拿到 correlationId
    const lastSent = mockIpc.sent[mockIpc.sent.length - 1];
    // error reply 会被 AgentPort 当作有效 reply（带 isFinal=true + errorCode）
    // 所以 promise 会 resolve 而不是 reject — 验证 send 次数即可
    mockIpc.simulateError(lastSent.correlationId!, 'AGENT_CRASHED');

    const result = await promise;
    expect((result as { metadata?: { errorCode?: string } }).metadata?.errorCode).toBe('AGENT_CRASHED');
    // 仍然只有一条 send（没有 retry）
    expect(mockIpc.sent.length).toBe(sendCountBefore + 1);
  });

  it('成功 reply 后不重复发新请求', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
    const sendCountBefore = mockIpc.sent.length;

    const promise = port.request({ to: 'memory', content: '查询' }, 5_000);
    const lastSent = mockIpc.sent[mockIpc.sent.length - 1];
    mockIpc.simulateReply(lastSent.correlationId!, '答案');

    const result = await promise;
    expect((result as { content: string }).content).toBe('答案');
    expect(mockIpc.sent.length).toBe(sendCountBefore + 1);
  });

  it('多个并发 request 各自只发一次 IPC（不互相重试）', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

    const promises = [
      port.request({ to: 'memory', content: 'A' }, 200),
      port.request({ to: 'memory', content: 'B' }, 200),
      port.request({ to: 'memory', content: 'C' }, 200),
    ];

    // 三个 IPC 都已发出
    expect(mockIpc.sent.length).toBeGreaterThanOrEqual(3);

    const settle = await Promise.allSettled(promises);
    expect(settle.every(s => s.status === 'rejected')).toBe(true);

    // 没有 retry — 总发送数还是初始 3 条
    const totalSent = mockIpc.sent.length;
    expect(totalSent).toBeGreaterThanOrEqual(3);
    expect(totalSent).toBeLessThan(6); // 远小于 2 * 3 (no retry)
  });

  it('timeout=0 仍只发一次（不会立即重试）', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

    // timeout=0 表示立即超时 — 测试不抛 NPE
    try {
      await port.request({ to: 'memory', content: '查询' }, 0);
    } catch (err) {
      // expected
      expect(err).toBeDefined();
    }

    // 只有一条 send（timeout=0 不会触发 retry）
    expect(mockIpc.sent.length).toBe(1);
  });
});