/**
 * AgentPort 单元测试 — 验证 6 原语的核心行为。
 *
 * 测试策略：mock IpcChildChannel，验证：
 * - request() 正确发送 dialogue.send 并在 dialogue.reply 时 resolve
 * - request() 超时时 reject
 * - request() 拒绝 to='brain'
 * - request() 拒绝 self-messaging
 * - send() 是 fire-and-forget
 * - askUser() 委托给 context.askUser
 * - useTool() 调用注册工具
 * - discover() 返回硬编码列表（排除 brain）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgentPort } from './agent-port.js';
import type { IpcChildChannel } from '../kernel/ipc.js';
import type { IpcMessage } from '../kernel/types.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';

type MessageHandler = (msg: IpcMessage) => void;

interface MockIpc {
  ipc: IpcChildChannel;
  sent: Array<{ type: string; to: string; payload: unknown }>;
  simulateReply: (dialogueId: string, content: string, metadata?: Record<string, unknown>) => void;
  /** L5: 模拟 Kernel 回复任意 IPC 消息 */
  simulateMessage: (type: string, payload: unknown) => void;
}

function createMockIpc(): MockIpc {
  const handlers = new Map<string, MessageHandler[]>();
  const sent: Array<{ type: string; to: string; payload: unknown }> = [];

  const ipc = {
    send: (type: string, to: string, payload: unknown) => {
      sent.push({ type, to, payload });
      return true;
    },
    onMessage: (type: string, handler: MessageHandler) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    request: vi.fn(),
  } as unknown as IpcChildChannel;

  /** 模拟 Kernel 转发 dialogue.reply 回到本 Agent */
  function simulateReply(dialogueId: string, content: string, metadata?: Record<string, unknown>) {
    const replyHandlers = handlers.get('dialogue.reply') ?? [];
    const msg = {
      id: 'msg-1',
      type: 'dialogue.reply' as const,
      from: 'core',
      to: 'code',
      payload: {
        dialogueId,
        sequenceNumber: 1,
        from: 'memory',
        to: 'code',
        content,
        metadata,
      },
      timestamp: Date.now(),
    };
    for (const h of replyHandlers) h(msg as unknown as IpcMessage);
  }

  /** L5: 模拟 Kernel 回复任意类型的 IPC 消息 */
  function simulateMessage(type: string, payload: unknown) {
    const typeHandlers = handlers.get(type) ?? [];
    const msg = {
      id: `msg-${type}`,
      type: type as IpcMessage['type'],
      from: 'core',
      to: 'code',
      payload,
      timestamp: Date.now(),
    };
    for (const h of typeHandlers) h(msg as unknown as IpcMessage);
  }

  return {
    ipc,
    sent,
    simulateReply,
    simulateMessage,
  };
}

describe('AgentPort', () => {
  let mockIpc: MockIpc;
  let askUser: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIpc = createMockIpc();
    askUser = vi.fn(async () => '用户回复');
  });

  describe('request()', () => {
    it('发送 dialogue.send 并在 dialogue.reply 时 resolve', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      const replyPromise = port.request({ to: 'memory', content: '查询用户偏好' });

      // 验证 dialogue.send 已发出
      expect(mockIpc.sent).toHaveLength(1);
      expect(mockIpc.sent[0].type).toBe('dialogue.send');
      expect(mockIpc.sent[0].to).toBe('core');
      const payload = mockIpc.sent[0].payload as DialogueMessagePayload;
      expect(payload.from).toBe('code');
      expect(payload.to).toBe('memory');
      expect(payload.content).toBe('查询用户偏好');

      // 模拟 Kernel 转发 reply
      mockIpc.simulateReply(payload.dialogueId, '用户偏好 TypeScript', { isFinal: true });

      const reply = await replyPromise;
      expect(reply.from).toBe('memory');
      expect(reply.content).toBe('用户偏好 TypeScript');
      expect(reply.metadata?.isFinal).toBe(true);
    });

    it('支持自定义 context 字段', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      const replyPromise = port.request({
        to: 'memory',
        content: 'test',
        context: { userId: 'u1', topic: 'preferences' },
      });

      const payload = mockIpc.sent[0].payload as DialogueMessagePayload;
      expect(payload.context).toEqual({ userId: 'u1', topic: 'preferences' });

      mockIpc.simulateReply(payload.dialogueId, 'OK');
      await replyPromise;
    });

    it('拒绝向 brain 发消息', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      await expect(
        port.request({ to: 'brain', content: '你好' }),
      ).rejects.toThrow(/brain.*forbidden/i);

      // 不应发送任何 IPC
      expect(mockIpc.sent).toHaveLength(0);
    });

    it('拒绝 self-messaging', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      await expect(
        port.request({ to: 'code', content: '自我对话' }),
      ).rejects.toThrow(/self-messaging/i);

      expect(mockIpc.sent).toHaveLength(0);
    });

    it('超时时 reject', async () => {
      vi.useFakeTimers();
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      const replyPromise = port.request({ to: 'memory', content: '慢查询' }, 5000);
      // 立即附加 .catch 处理器，防止 fake timer 触发后成为 unhandled rejection
      const handledPromise = replyPromise.catch(e => e);

      // 快进超过超时时间
      await vi.advanceTimersByTimeAsync(5100);

      const error = await handledPromise;
      expect((error as Error).message).toMatch(/timeout/i);

      vi.useRealTimers();
    });
  });

  describe('send()', () => {
    it('fire-and-forget 不等待 reply', () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      port.send({ to: 'memory', content: '通知一下' });

      expect(mockIpc.sent).toHaveLength(1);
      expect(mockIpc.sent[0].type).toBe('dialogue.send');
      const payload = mockIpc.sent[0].payload as DialogueMessagePayload;
      expect(payload.to).toBe('memory');
      expect(payload.content).toBe('通知一下');
    });

    it('拒绝向 brain 即发即弃', () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      expect(() => port.send({ to: 'brain', content: 'x' })).toThrow(/brain.*forbidden/i);
      expect(mockIpc.sent).toHaveLength(0);
    });

    it('拒绝 self-messaging 即发即弃', () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      expect(() => port.send({ to: 'code', content: 'x' })).toThrow(/self-messaging/i);
      expect(mockIpc.sent).toHaveLength(0);
    });
  });

  describe('discover()', () => {
    it('通过 IPC 查询 Kernel Agent 注册表（L5 实时目录）', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      // 模拟 Kernel 回复 discover 结果
      const discoverPromise = port.discover();

      // 捕获 IPC 发出的 agent.discover 消息
      const discoverMsg = mockIpc.sent.find(m => m.type === 'agent.discover');
      expect(discoverMsg).toBeDefined();

      // 模拟 Kernel 回复
      const mockAgents = [
        { name: 'memory', description: '记忆管理', capabilities: ['query'], status: 'online' },
        { name: 'learning', description: '学习', capabilities: ['extract'], status: 'online' },
      ];
      mockIpc.simulateMessage('agent.discover.reply', mockAgents);

      const agents = await discoverPromise;
      expect(agents.length).toBeGreaterThan(0);
      // L5: 不再硬编码排除 brain，而是 Kernel 端过滤
      expect(agents.find(a => a.name === 'memory')).toBeDefined();
    });
  });

  describe('askUser()', () => {
    it('委托给 context.askUser 并透传参数', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });

      const result = await port.askUser('需要确认', {
        options: ['A', 'B'],
        context: 'ctx',
        timeoutMs: 30_000,
      });

      expect(result).toBe('用户回复');
      expect(askUser).toHaveBeenCalledWith('需要确认', {
        options: ['A', 'B'],
        context: 'ctx',
        timeoutMs: 30_000,
      });
    });
  });

  describe('useTool()', () => {
    it('调用注册的工具', async () => {
      // 动态注册一个测试工具
      const { registerTool, clearDynamicTools } = await import('../tools/index.js');
      clearDynamicTools(['mock-tool']);
      registerTool({
        name: 'mock-tool',
        description: 'mock',
        dangerLevel: 'safe',
        inputSchema: { parse: (x: unknown) => x } as never,
        execute: async (input: unknown) => {
          return { content: `executed with ${JSON.stringify(input)}` };
        },
      });

      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
      const result = await port.useTool('mock-tool', { foo: 'bar' });

      expect(result.content).toBe('executed with {"foo":"bar"}');
      expect(result.isError).toBeUndefined();

      clearDynamicTools(['mock-tool']);
    });

    it('工具不存在时返回错误', async () => {
      const port = createAgentPort({ ipc: mockIpc.ipc, agentName: 'code', askUser });
      const result = await port.useTool('non-existent-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content).toContain('不存在');
    });
  });
});