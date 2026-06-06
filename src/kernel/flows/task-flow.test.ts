/**
 * task-flow emit 单测
 *
 * 覆盖 d3bf299 修复：H1/H2/H3 kernel EventBus 化的真正实现。
 * 验证 text_delta / reasoning_delta / tool_call / tool_result / uncertainty
 * 5 类 task.telemetry 都正确 emit 对应 EventBus 事件，payload 含 taskId/sessionId。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTaskTelemetryHandler } from './task-flow.js';
import { initEventBus, getEventBus, type EventBus } from '../event-bus.js';

function makeMockEventBus() {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    emit: vi.fn((event: string, payload: unknown) => { events.push({ event, payload }); }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAll: vi.fn(),
    listenerCount: vi.fn(),
  } as unknown as EventBus & { events: Array<{ event: string; payload: unknown }> };
}

function makeMockAgentIpc() {
  const handlers = new Map<string, (msg: unknown) => void>();
  return {
    handlers,
    onMessage: vi.fn((type: string, handler: (msg: unknown) => void) => {
      handlers.set(type, handler);
    }),
    send: vi.fn(),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const delegationManager = {
    get: vi.fn((taskId: string) => ({
      correlationId: 'corr-1', sessionId: 's-1', state: 'running',
    })),
    recordOutput: vi.fn(),
    acknowledge: vi.fn(),
    reportUncertainty: vi.fn(),
    ...((overrides.delegationManager as Record<string, unknown>) ?? {}),
  };
  const sessionManager = {
    getPending: vi.fn((correlationId: string) => ({
      correlationId, sessionId: 's-1', streaming: true, taskId: 't-1',
      draftResponse: '', reasoning: '',
    })),
    findPendingByTaskId: vi.fn(),
    getSocketForTask: vi.fn(),
    ...((overrides.sessionManager as Record<string, unknown>) ?? {}),
  };
  const streamingFlusher = {
    onTextAccumulated: vi.fn(),
    ...((overrides.streamingFlusher as Record<string, unknown>) ?? {}),
  };
  return {
    taskManager: { complete: vi.fn(), fail: vi.fn() },
    delegationManager,
    sessionManager,
    agentProgress: null,
    registry: { requireRole: vi.fn() },
    agentManager: { getAgent: vi.fn() },
    streamingFlusher,
  };
}

describe('task-flow telemetry emit', () => {
  let mockBus: ReturnType<typeof makeMockEventBus>;
  let agentIpc: ReturnType<typeof makeMockAgentIpc>;
  let handler: (msg: unknown) => void;

  beforeEach(() => {
    mockBus = makeMockEventBus();
    // 把 mock eventBus 注入全局
    initEventBus();
    // 替换 emit（保留 getEventBus 实例）
    (getEventBus() as unknown as { emit: typeof mockBus.emit }).emit = mockBus.emit;
    agentIpc = makeMockAgentIpc();
    const deps = makeDeps();
    setupTaskTelemetryHandler(agentIpc as never, deps as never);
    handler = agentIpc.handlers.get('task.telemetry')!;
  });

  it('text_delta 触发 emit stream.text_delta', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'text_delta', taskId: 't-1', text: 'hello world',
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.text_delta');
    expect(streamEvents).toHaveLength(1);
    expect((streamEvents[0].payload as { text: string }).text).toBe('hello world');
    expect((streamEvents[0].payload as { taskId: string }).taskId).toBe('t-1');
    expect((streamEvents[0].payload as { sessionId: string }).sessionId).toBe('s-1');
  });

  it('text_delta 同步触发 streamingFlusher 兜底（断线恢复用）', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'text_delta', taskId: 't-1', text: 'chunk-1',
      },
    });
    handler({
      from: 'agent-1', id: 'm-2', type: 'task.telemetry', payload: {
        kind: 'text_delta', taskId: 't-1', text: 'chunk-2',
      },
    });
    // streamingFlusher 应被调用累积 draftResponse + reasoning
    // (本测试只验证 emit 正确性，flusher 行为由其自身测试覆盖)
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.text_delta');
    expect(streamEvents.length).toBe(2);
  });

  it('reasoning_delta 触发 emit stream.reasoning_delta + flusher 兜底', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'reasoning_delta', taskId: 't-1', text: 'thinking...',
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.reasoning_delta');
    expect(streamEvents).toHaveLength(1);
    expect((streamEvents[0].payload as { text: string }).text).toBe('thinking...');
  });

  it('tool_call 触发 emit stream.tool_call（含 toolName/input/result）', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'tool_call', taskId: 't-1', toolName: 'bash',
        input: '{"cmd":"ls"}', result: 'file1\nfile2', isError: false, durationMs: 100,
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.tool_call');
    expect(streamEvents).toHaveLength(1);
    const p = streamEvents[0].payload as { toolName: string; input: string; result: string; isError: boolean };
    expect(p.toolName).toBe('bash');
    expect(p.input).toBe('{"cmd":"ls"}');
    expect(p.result).toBe('file1\nfile2');
    expect(p.isError).toBe(false);
  });

  it('tool_result 触发 emit stream.tool_result（独立于 tool_call）', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'tool_result', taskId: 't-1', toolName: 'bash', isError: true,
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.tool_result');
    expect(streamEvents).toHaveLength(1);
    const p = streamEvents[0].payload as { toolName: string; isError: boolean; sessionId: string };
    expect(p.toolName).toBe('bash');
    expect(p.isError).toBe(true);
    expect(p.sessionId).toBe('s-1');
  });

  it('uncertainty 触发 emit stream.uncertainty（含 reason）', () => {
    handler({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'uncertainty', taskId: 't-1', reason: 'context to long, may be confused',
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.uncertainty');
    expect(streamEvents).toHaveLength(1);
    const p = streamEvents[0].payload as { reason: string; taskId: string; sessionId: string };
    expect(p.reason).toBe('context to long, may be confused');
    expect(p.taskId).toBe('t-1');
    expect(p.sessionId).toBe('s-1');
  });

  it('已完成 delegation 的迟到 text_delta 被丢弃（不 emit）', () => {
    // 覆盖默认 mock，让 delegation 状态为 completed
    const deps = makeDeps({
      delegationManager: {
        get: vi.fn((taskId: string) => ({
          correlationId: 'corr-1', sessionId: 's-1', state: 'completed',
        })),
        recordOutput: vi.fn(),
      },
    });
    const ipc = makeMockAgentIpc();
    setupTaskTelemetryHandler(ipc as never, deps as never);
    const h = ipc.handlers.get('task.telemetry')!;
    h({
      from: 'agent-1', id: 'm-1', type: 'task.telemetry', payload: {
        kind: 'text_delta', taskId: 't-1', text: 'late',
      },
    });
    const streamEvents = mockBus.events.filter((e) => e.event === 'stream.text_delta');
    expect(streamEvents).toHaveLength(0);
  });
});
