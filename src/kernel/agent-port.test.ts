/**
 * AgentPort 契约单元测试 — 13.0 架构
 *
 * 验证 6 原语契约的行为正确性。
 * 不依赖真实 IPC，只验证类型契约和封装逻辑。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPortImpl } from './agent-port.js';
import type { IpcMessage, IpcMessageType } from './types.js';
import type { ToolDefinition } from '../tools/types.js';

function makeIpcMock() {
  const handlers = new Map<string, (msg: IpcMessage) => void>();
  return {
    handlers,
    onMessage(type: IpcMessageType, handler: (msg: IpcMessage) => void) {
      handlers.set(type, handler);
    },
    send: vi.fn(),
    request: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeIpcMessage(
  type: string,
  payload: unknown,
  correlationId?: string,
): IpcMessage {
  return {
    id: 'msg-1',
    type,
    from: 'other-agent',
    to: 'conversation',
    payload,
    timestamp: Date.now(),
    correlationId,
  };
}

describe('AgentPort', () => {
  let ipc: ReturnType<typeof makeIpcMock>;
  let port: AgentPortImpl;

  beforeEach(() => {
    ipc = makeIpcMock();
    port = new AgentPortImpl(ipc as any, { agentName: 'test-agent' });
  });

  describe('directory 缓存', () => {
    it('初始缓存为空，discover 通过 IPC 请求填充', async () => {
      const reply = makeIpcMessage('port.discover', { agents: [{ name: 'learning', description: '记忆', handles: ['agent.question'], status: 'ready', level: 1 }] });
      ipc.request.mockResolvedValueOnce(reply);

      const result = await port.discover();
      expect(ipc.request).toHaveBeenCalledWith('port.discover', 'core', {}, 10_000);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('learning');
    });

    it('收到 port.directory_changed 时更新缓存', () => {
      const handler = ipc.handlers.get('port.directory_changed' as IpcMessageType);
      expect(handler).toBeDefined();
      handler!(makeIpcMessage('port.directory_changed', {
        agents: [{ name: 'code', description: '代码', handles: [], status: 'ready', level: 2 }],
      }));
      // 缓存已更新 — 下次 discover 不发 IPC 请求
      // 注意：mockResolvedValue 在第二次调用时会返回 undefined
      return port.discover().then((agents) => {
        expect(agents).toHaveLength(1);
        expect(agents[0].name).toBe('code');
      });
    });
  });

  describe('useTool 本地执行', () => {
    it('safe 工具本地执行', async () => {
      const tool: ToolDefinition = {
        name: 'test_safe',
        description: 'safe tool',
        inputSchema: { parse: (x: unknown) => x } as any,
        dangerLevel: 'safe',
        execute: vi.fn().mockResolvedValue({ content: 'result', isError: false }),
      };
      const portWithTool = new AgentPortImpl(ipc as any, {
        agentName: 'test-agent',
        toolLookup: (name) => (name === 'test_safe' ? tool : undefined),
      });

      const result = await portWithTool.useTool('test_safe', { x: 1 });
      expect(result.success).toBe(true);
      expect(result.output).toBe('result');
      expect(result.approvedBy).toBe('auto');
      expect(tool.execute).toHaveBeenCalledWith({ x: 1 });
      // safe 工具不应走 IPC
      expect(ipc.request).not.toHaveBeenCalled();
    });

    it('工具未注册返回错误', async () => {
      const result = await port.useTool('unknown_tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('工具未注册');
    });

    it('moderate 工具走 IPC', async () => {
      const tool: ToolDefinition = {
        name: 'test_moderate',
        description: 'moderate tool',
        inputSchema: { parse: (x: unknown) => x } as any,
        dangerLevel: 'moderate',
        execute: vi.fn(),
      };
      const portWithTool = new AgentPortImpl(ipc as any, {
        agentName: 'test-agent',
        toolLookup: (name) => (name === 'test_moderate' ? tool : undefined),
      });
      ipc.request.mockResolvedValueOnce(
        makeIpcMessage('port.use_tool', { success: true, output: 'ok' }),
      );

      const result = await portWithTool.useTool('test_moderate', { y: 2 });
      expect(ipc.request).toHaveBeenCalledWith(
        'port.use_tool',
        'core',
        { name: 'test_moderate', input: { y: 2 }, dangerLevel: 'moderate' },
        60_000,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('send/request', () => {
    it('send 翻译为 port.notify', () => {
      port.send({ to: 'learning', type: 'agent.notify', payload: { foo: 'bar' } });
      expect(ipc.send).toHaveBeenCalledWith(
        'port.notify',
        'core',
        { target: 'learning', type: 'agent.notify', payload: { foo: 'bar' } },
        undefined,
      );
    });

    it('request 翻译为 port.request', async () => {
      ipc.request.mockResolvedValueOnce(
        makeIpcMessage('port.request', { type: 'agent.answer', payload: { answer: '42' } }, 'corr-1'),
      );

      const result = await port.request({ to: 'learning', type: 'agent.question', payload: { q: 'meaning' } });
      expect(ipc.request).toHaveBeenCalledWith(
        'port.request',
        'core',
        { target: 'learning', type: 'agent.question', payload: { q: 'meaning' } },
        30_000,
      );
      expect(result.payload).toEqual({ answer: '42' });
    });
  });

  describe('on 处理器', () => {
    it('注册的 handler 被 IPC 消息触发', () => {
      const handler = vi.fn();
      port.on('user.message', handler);
      const ipcHandler = ipc.handlers.get('user.message' as IpcMessageType);
      expect(ipcHandler).toBeDefined();
      ipcHandler!(makeIpcMessage('user.message', { text: 'hi' }));
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user.message',
        payload: { text: 'hi' },
      }));
    });
  });
});
