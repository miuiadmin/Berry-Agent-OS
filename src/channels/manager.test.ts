/**
 * ChannelManager 单元测试
 *
 * 覆盖 initEventBridge / disposeEventBridge：
 * 1. conversation.result 事件通过 sessionId 前缀匹配分发到对应 channel
 * 2. 非 channel 前缀的 sessionId 被忽略（WS 由 WsEventBridge 独立处理）
 * 3. channel 不存在时仅 warn 不抛错
 * 4. disposeEventBridge 后不再收到事件
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelManager } from './manager.js';
import type { MessageChannel, IncomingMessage, OutgoingMessage } from './contract.js';
import type { EventBus } from '../kernel/event-bus.js';

/** mock 最小可用的 EventBus（仅暴露 on） */
function makeMockEventBus(): EventBus & { emitAny: (event: string, payload: unknown) => void } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)?.delete(listener);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    once: vi.fn(),
    removeAll: vi.fn(),
    listenerCount: vi.fn((event: string) => listeners.get(event)?.size ?? 0),
    /** 测试 helper：直接派发到 listeners */
    emitAny: (event: string, payload: unknown) => {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
  } as unknown as EventBus & { emitAny: (event: string, payload: unknown) => void };
}

/** mock 最小可用的 MessageChannel */
function makeMockChannel(type: string): MessageChannel & { sentMessages: Array<{ userId: string; message: OutgoingMessage }> } {
  const sentMessages: Array<{ userId: string; message: OutgoingMessage }> = [];
  return {
    type,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onMessage: vi.fn(() => {}),
    send: vi.fn(async (userId: string, message: OutgoingMessage) => {
      sentMessages.push({ userId, message });
    }),
    sentMessages,
  };
}

describe('ChannelManager', () => {
  let manager: ChannelManager;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeEach(() => {
    manager = new ChannelManager();
    eventBus = makeMockEventBus();
  });

  describe('initEventBridge', () => {
    it('订阅 conversation.result 事件', () => {
      manager.initEventBridge(eventBus);
      expect(eventBus.on).toHaveBeenCalledWith('conversation.result', expect.any(Function));
    });

    it('sessionId 匹配 channel-cli-user123 时调用对应 channel 的 send', async () => {
      const cliChannel = makeMockChannel('cli');
      manager.register(cliChannel);
      manager.initEventBridge(eventBus);

      eventBus.emitAny('conversation.result', {
        sessionId: 'channel-cli-user123',
        taskId: 'task-1',
        response: '你好世界',
      });

      // send 是 async，等一个微任务
      await vi.waitFor(() => {
        expect(cliChannel.send).toHaveBeenCalledWith('user123', { text: '你好世界' });
      });
    });

    it('sessionId 匹配 channel-telegram-chat456 时调用对应 channel 的 send', async () => {
      const tgChannel = makeMockChannel('telegram');
      manager.register(tgChannel);
      manager.initEventBridge(eventBus);

      eventBus.emitAny('conversation.result', {
        sessionId: 'channel-telegram-chat456',
        taskId: 'task-2',
        response: '回复内容',
      });

      await vi.waitFor(() => {
        expect(tgChannel.send).toHaveBeenCalledWith('chat456', { text: '回复内容' });
      });
    });

    it('非 channel 前缀的 sessionId 被忽略（WS 的 ses-xxx 格式）', async () => {
      const cliChannel = makeMockChannel('cli');
      manager.register(cliChannel);
      manager.initEventBridge(eventBus);

      eventBus.emitAny('conversation.result', {
        sessionId: 'ses-abc123',
        taskId: 'task-3',
        response: 'WS 消息',
      });

      // 等一个微任务确认 send 没被调用
      await new Promise((r) => setTimeout(r, 10));
      expect(cliChannel.send).not.toHaveBeenCalled();
    });

    it('channel 不存在时仅 warn 不抛错', async () => {
      // 不注册任何 channel，直接触发
      manager.initEventBridge(eventBus);

      // 不应抛错
      eventBus.emitAny('conversation.result', {
        sessionId: 'channel-cli-user123',
        taskId: 'task-4',
        response: '内容',
      });

      // 无异常即通过（ChannelManager.send 内部仅 warn）
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('disposeEventBridge', () => {
    it('取消订阅后不再收到事件', async () => {
      const cliChannel = makeMockChannel('cli');
      manager.register(cliChannel);
      manager.initEventBridge(eventBus);
      manager.disposeEventBridge();

      eventBus.emitAny('conversation.result', {
        sessionId: 'channel-cli-user123',
        taskId: 'task-5',
        response: '不应收到',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(cliChannel.send).not.toHaveBeenCalled();
    });
  });
});
