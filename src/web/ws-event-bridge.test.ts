/**
 * WsEventBridge 单元测试
 *
 * 覆盖：
 * 1. STREAM_EVENT_MAPPING 10 个事件全部订阅 EventBus
 * 2. 流式事件以"顶层 payload"格式（不是包装格式）序列化
 * 3. 全局事件以 {type:'event', event, payload, ts} 包装格式序列化
 * 4. 广播给所有 readyState=1 (OPEN) 的 ws 客户端
 * 5. dispose() 取消订阅
 *
 * 这是 d3bf299 修复后新增的覆盖：之前 commit 自宣称"1309/1322 测试通过"
 * 但实际是 pre-existing 测试不覆盖新加的 STREAM_EVENT_MAPPING 桥接层。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WsEventBridge } from './ws-event-bridge.js';
import { initEventBus, getEventBus, type EventBus } from '../kernel/event-bus.js';

/** mock 一个最小可用的 EventBus（仅暴露 on + emit） */
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
    // 测试 helper：直接派发到 listeners
    emitAny: (event: string, payload: unknown) => {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
  } as unknown as EventBus & { emitAny: (event: string, payload: unknown) => void };
}

/** mock 一个最小可用的 WebSocketServer（支持 connection 事件） */
function makeMockWss() {
  const clients: Array<{ readyState: number; sent: string[]; send: (msg: string) => void; on: (event: string, handler: (data: unknown) => void) => void }> = [];
  const connectionHandlers: Array<(ws: unknown) => void> = [];
  return {
    clients: {
      [Symbol.iterator]: function* () {
        for (const c of clients) yield c as unknown as never;
      },
      forEach: (cb: (c: { readyState: number; sent: string[] }) => void) => {
        for (const c of clients) cb(c);
      },
      // 直接暴露数组便于测试断言
      _list: clients,
    } as never,
    /** P2-11: WsEventBridge 构造时注册 connection 监听器 */
    on: vi.fn((event: string, handler: (ws: unknown) => void) => {
      if (event === 'connection') connectionHandlers.push(handler);
    }),
    addClient: (readyState: number) => {
      const messageHandlers: Array<(data: unknown) => void> = [];
      const closeHandlers: Array<() => void> = [];
      const client = {
        readyState,
        sent: [] as string[],
        send: function (msg: string) { this.sent.push(msg); },
        on: function (event: string, handler: (data: unknown) => void) {
          if (event === 'message') messageHandlers.push(handler);
          if (event === 'close') closeHandlers.push(handler);
        },
        // 测试 helper：模拟客户端发送 subscribe 消息
        _simulateMessage: (data: unknown) => {
          for (const h of messageHandlers) h(data);
        },
        // 测试 helper：模拟客户端断连
        _simulateClose: () => {
          for (const h of closeHandlers) h();
        },
      };
      clients.push(client);
      // 触发 WsEventBridge 注册的 connection handler
      for (const h of connectionHandlers) h(client);
      return client;
    },
  };
}

describe('WsEventBridge', () => {
  let mockBus: ReturnType<typeof makeMockEventBus>;
  let mockWss: ReturnType<typeof makeMockWss>;
  let bridge: WsEventBridge;

  beforeEach(() => {
    mockBus = makeMockEventBus();
    mockWss = makeMockWss();
    bridge = new WsEventBridge(mockWss as never, mockBus);
  });

  it('订阅了 10 个流式事件（STREAM_EVENT_MAPPING）', () => {
    // 1. 全局事件 BRIDGED_EVENTS + 2. 流式 STREAM_EVENT_MAPPING
    // 期望至少订阅 10 个流式事件 + 38 个全局事件
    const calls = (mockBus.on as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const subscribedEvents = calls.map((c) => c[0]);
    const expectedStreamEvents = [
      'stream.text_delta', 'stream.reasoning_delta', 'stream.tool_call', 'stream.tool_result',
      'stream.uncertainty', 'dialogue.status',
      'conversation.handoff', 'conversation.ask_user', 'conversation.progress', 'conversation.no_response',
    ];
    for (const ev of expectedStreamEvents) {
      expect(subscribedEvents).toContain(ev);
    }
  });

  it('订阅了 BRIDGED_EVENTS 中的全局事件', () => {
    const calls = (mockBus.on as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const subscribedEvents = calls.map((c) => c[0]);
    expect(subscribedEvents).toContain('task.created');
    expect(subscribedEvents).toContain('task.completed');
    expect(subscribedEvents).toContain('agent.crashed');
    expect(subscribedEvents).toContain('cron.fired');
  });

  it('流式事件以"顶层 payload"格式序列化（无 type:event 包装）', () => {
    mockWss.addClient(1);
    // 模拟 stream.text_delta 触发
    mockBus.emitAny('stream.text_delta', {
      taskId: 't-1', sessionId: 's-1', text: 'hello', correlationId: 'c-1',
    });
    const sent = mockWss.clients._list[0].sent;
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    // 顶层格式：type=text_delta（不是 event）+ payload 平铺
    expect(parsed.type).toBe('text_delta');
    expect(parsed.text).toBe('hello');
    expect(parsed.taskId).toBe('t-1');
    expect(parsed.sessionId).toBe('s-1');
    expect(parsed.correlationId).toBe('c-1');
    expect(parsed.ts).toBeTypeOf('number');
  });

  it('全局事件以包装格式 {type:event, event, payload, ts} 序列化', () => {
    mockWss.addClient(1);
    mockBus.emitAny('task.completed', { taskId: 't-2', sessionId: 's-2' });
    const sent = mockWss.clients._list[0].sent;
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.type).toBe('event');
    expect(parsed.event).toBe('task.completed');
    expect(parsed.payload).toEqual({ taskId: 't-2', sessionId: 's-2' });
    expect(parsed.ts).toBeTypeOf('number');
  });

  it('广播给所有 readyState=1 (OPEN) 的 ws 客户端', () => {
    const c1 = mockWss.addClient(1); // OPEN
    const c2 = mockWss.addClient(0); // CONNECTING — 应跳过
    const c3 = mockWss.addClient(1); // OPEN
    const c4 = mockWss.addClient(3); // CLOSED — 应跳过
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's', text: 'x' });
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(0);
    expect(c3.sent).toHaveLength(1);
    expect(c4.sent).toHaveLength(0);
  });

  it('所有 10 个流式事件名映射到正确的 ws 消息 type', () => {
    const mapping: Record<string, string> = {
      'stream.text_delta': 'text_delta',
      'stream.reasoning_delta': 'reasoning_delta',
      'stream.tool_call': 'tool_call',
      'stream.tool_result': 'tool_result',
      'stream.uncertainty': 'uncertainty',
      'dialogue.status': 'dialogue_status',
      'conversation.handoff': 'agent_handoff',
      'conversation.ask_user': 'ask_user',
      'conversation.progress': 'progress',
      'conversation.no_response': 'no_response',
    };
    mockWss.addClient(1);
    for (const [busEvent, wsType] of Object.entries(mapping)) {
      mockBus.emitAny(busEvent, { sessionId: 's' });
    }
    const sent = mockWss.clients._list[0].sent;
    expect(sent).toHaveLength(Object.keys(mapping).length);
    const parsedTypes = sent.map((m) => JSON.parse(m).type);
    for (const wsType of Object.values(mapping)) {
      expect(parsedTypes).toContain(wsType);
    }
  });

  it('dispose() 取消所有订阅（无新事件触发广播）', () => {
    const client = mockWss.addClient(1);
    bridge.dispose();
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's', text: 'after dispose' });
    expect(client.sent).toHaveLength(0);
  });

  // P2-11: per-client sessionId 过滤测试

  it('未订阅任何 session 的客户端收到所有流式事件', () => {
    const client = mockWss.addClient(1);
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-1', text: 'hello' });
    expect(client.sent).toHaveLength(1);
  });

  it('订阅了特定 sessionId 的客户端只收到该 session 的流式事件', () => {
    const c1 = mockWss.addClient(1);
    const c2 = mockWss.addClient(1);
    // c1 订阅 s-1，c2 订阅 s-2
    c1._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-1' })));
    c2._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-2' })));
    // 发送 s-1 的事件
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-1', text: 'for s-1' });
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(0);
    // 发送 s-2 的事件
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-2', text: 'for s-2' });
    expect(c1.sent).toHaveLength(1); // 不再收到
    expect(c2.sent).toHaveLength(1);
  });

  it('全局事件（task.*）不受 sessionId 过滤影响，广播给所有客户端', () => {
    const c1 = mockWss.addClient(1);
    const c2 = mockWss.addClient(1);
    c1._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-1' })));
    // task.completed 不带 sessionId 过滤
    mockBus.emitAny('task.completed', { taskId: 't', targetAgent: 'brain' });
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
  });

  it('客户端断连后自动清理订阅', () => {
    const c1 = mockWss.addClient(1);
    c1._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-1' })));
    // 断连
    c1.readyState = 3; // CLOSED
    c1._simulateClose();
    // 新客户端订阅同一 session
    const c2 = mockWss.addClient(1);
    c2._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-1' })));
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-1', text: 'after close' });
    expect(c1.sent).toHaveLength(0); // 已断连，不再收到
    expect(c2.sent).toHaveLength(1);
  });

  it('unsubscribe 取消特定 session 订阅', () => {
    const client = mockWss.addClient(1);
    client._simulateMessage(Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: 's-1' })));
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-1', text: 'before unsub' });
    expect(client.sent).toHaveLength(1);
    // 取消订阅
    client._simulateMessage(Buffer.from(JSON.stringify({ type: 'unsubscribe', sessionId: 's-1' })));
    // 订阅集合为空 → 收到所有事件（兼容旧行为）
    mockBus.emitAny('stream.text_delta', { taskId: 't', sessionId: 's-2', text: 'after unsub' });
    expect(client.sent).toHaveLength(2); // 取消订阅后回到广播模式
  });
});
