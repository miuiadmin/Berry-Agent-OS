/**
 * AgentPort.requestStreaming() v2 单测 — fake timers 版本（避免微任务/宏任务竞态）。
 *
 * §4.4.6: 流式请求 — 持续接收同 dialogueId 的 reply 直到 isFinal=true。
 *
 * 使用 vitest 的 vi.useFakeTimers() + vi.advanceTimersByTimeAsync()
 * 精确控制 setTimeout 触发，避免之前实测试遇到的死锁问题。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcChildChannel, IpcMessage } from '../kernel/types.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';
import { createAgentPort } from './agent-port.js';

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

  /** 同步触发所有 reply handler（不通过 setTimeout） */
  fireReply(correlationId: string, content: string, isFinal = false): void {
    const sent = this.sent.find(s => s.correlationId === correlationId);
    if (!sent) throw new Error(`No IPC sent with cid=${correlationId}`);
    const payload = sent.payload as DialogueMessagePayload;
    const reply: DialogueMessagePayload = {
      ...payload,
      sequenceNumber: (payload.sequenceNumber ?? -1) + 1,
      from: sent.to,
      to: payload.from,
      content,
      metadata: isFinal ? { isFinal: true } : { isFinal: false },
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

describe('AgentPort.requestStreaming() — fake timers 版（13.0 §4.4.6）', () => {
  let mockIpc: MockIpc;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIpc = new MockIpc();
    askUser.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同步触发多个 chunk 后 isFinal 正确结束', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

    // 启动 generator（不要 await — fireReply 必须同步触发 handler）
    const gen = port.requestStreaming({ to: 'memory', content: '流式查询' }, 5_000);
    const iter = gen[Symbol.asyncIterator]();

    // 触发 generator body（同步执行直到第一次 await）
    const firstNext = iter.next();
    // 让 microtask 跑一下让 generator 进入 wait branch
    await vi.advanceTimersByTimeAsync(0);

    // 拿到 correlationId（IPC 已经在 generator body 里发出）
    const lastSent = mockIpc.sent[mockIpc.sent.length - 1];
    expect(lastSent).toBeDefined();
    const cid = lastSent.correlationId!;

    // 同步触发 3 个 chunk
    mockIpc.fireReply(cid, 'chunk-1');
    mockIpc.fireReply(cid, 'chunk-2');
    mockIpc.fireReply(cid, 'chunk-3', true);

    // 让所有 microtask 跑完
    await vi.advanceTimersByTimeAsync(0);

    // 收集结果
    const received: string[] = [];
    let next = await firstNext;
    while (!next.done) {
      received.push((next.value as { content: string }).content);
      next = await iter.next();
    }

    expect(received).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    // 只发了一次 dialogue.send
    expect(mockIpc.sent.length).toBe(1);
  });

  it('拒绝向 brain 发送', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
    const gen = port.requestStreaming({ to: 'brain', content: 'test' }, 1_000);

    await expect((async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) { /* drain */ }
    })()).rejects.toThrow(/brain.*forbidden/i);
    expect(mockIpc.sent).toHaveLength(0);
  });

  it('isFinal=true 后多余的 reply 被丢弃', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

    const gen = port.requestStreaming({ to: 'memory', content: 'q' }, 5_000);
    const iter = gen[Symbol.asyncIterator]();
    const firstNext = iter.next();
    await vi.advanceTimersByTimeAsync(0);

    const cid = mockIpc.sent[mockIpc.sent.length - 1].correlationId!;

    mockIpc.fireReply(cid, 'first', true);
    mockIpc.fireReply(cid, 'late-1');  // 已被 closed 丢弃
    mockIpc.fireReply(cid, 'late-2');  // 同上

    await vi.advanceTimersByTimeAsync(0);

    const received: string[] = [];
    let next = await firstNext;
    while (!next.done) {
      received.push((next.value as { content: string }).content);
      next = await iter.next();
    }
    expect(received).toEqual(['first']);
  });

  it('整体超时强制结束（fake timer 加速）', async () => {
    const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

    // 100ms 整体超时
    const gen = port.requestStreaming({ to: 'memory', content: 'slow' }, 100);

    // 触发 generator body 进入 wait branch
    const iter = gen[Symbol.asyncIterator]();
    const firstNext = iter.next();
    // 捕获 unhandled rejection（generator body 会 throw）
    firstNext.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // 不发任何 reply — 让 100ms 整体超时
    // 内部还有 5s 段内超时（不视为整体超时），需要走完整 5s
    // 把 fake timer 推到 6s 让整体超时触发
    await vi.advanceTimersByTimeAsync(6000);

    await expect(firstNext).rejects.toThrow(/streaming timeout/i);
  });
});