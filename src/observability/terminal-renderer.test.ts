import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../kernel/event-bus.js';
import { TerminalRenderer } from './terminal-renderer.js';

describe('TerminalRenderer', () => {
  let eventBus: EventBus;
  let renderer: TerminalRenderer;
  let output: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    eventBus = new EventBus();
    renderer = new TerminalRenderer();
    output = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
    renderer.start(eventBus);
  });

  afterEach(() => {
    renderer.stop();
    writeSpy.mockRestore();
  });

  it('renders agent.registered', () => {
    eventBus.emit('agent.registered', { name: 'brain', pid: 1234 });
    expect(output.some(l => l.includes('brain') && l.includes('就绪'))).toBe(true);
  });

  it('renders agent.crashed', () => {
    eventBus.emit('agent.crashed', { name: 'conversation', error: 'OOM' });
    expect(output.some(l => l.includes('conversation') && l.includes('崩溃'))).toBe(true);
  });

  it('renders task.created', () => {
    eventBus.emit('task.created', { taskId: 'abcdef12345678', taskType: 'code_task', targetAgent: 'code' });
    expect(output.some(l => l.includes('code') && l.includes('任务创建'))).toBe(true);
  });

  it('renders task.completed', () => {
    eventBus.emit('task.completed', { taskId: 'abcdef12345678', targetAgent: 'code', outputPayload: {} });
    expect(output.some(l => l.includes('code') && l.includes('任务完成'))).toBe(true);
  });

  it('renders task.failed', () => {
    eventBus.emit('task.failed', { taskId: 'abcdef12345678', targetAgent: 'code', error: 'timeout' });
    expect(output.some(l => l.includes('code') && l.includes('任务失败'))).toBe(true);
  });

  it('renders tool.executed', () => {
    eventBus.emit('tool.executed', { agentName: 'conv', toolName: 'shell', durationMs: 50, isError: false });
    expect(output.some(l => l.includes('shell') && l.includes('conv'))).toBe(true);
  });

  it('renders message.received', () => {
    eventBus.emit('message.received', { sessionId: 's1', message: '你好世界', taskId: 't1' });
    expect(output.some(l => l.includes('你好世界'))).toBe(true);
  });

  it('renders message.routed', () => {
    eventBus.emit('message.routed', { sessionId: 's1', taskId: 't1', targetAgent: 'code', intent: 'code' });
    expect(output.some(l => l.includes('code') && l.includes('Brain'))).toBe(true);
  });

  it('renders message.responded', () => {
    eventBus.emit('message.responded', { sessionId: 's1', taskId: 't1', response: '这是回复', verdict: 'approved' });
    expect(output.some(l => l.includes('回复') && l.includes('这是回复'))).toBe(true);
  });

  it('renders llm.request.completed', () => {
    eventBus.emit('llm.request.completed', {
      agentName: 'conversation',
      inputTokens: 150,
      outputTokens: 80,
      cacheRead: 1200,
      durationMs: 500,
    });
    expect(output.some(l => l.includes('conversation') && l.includes('150+80') && l.includes('cache:1200'))).toBe(true);
  });

  it('renders delegation.created', () => {
    eventBus.emit('delegation.created', { delegationId: 'del12345678', sessionId: 's1', targetAgent: 'code' });
    expect(output.some(l => l.includes('code') && l.includes('委派'))).toBe(true);
  });

  it('renders mcp.connected', () => {
    eventBus.emit('mcp.connected', { serverName: 'github', toolCount: 5, capabilities: [] });
    expect(output.some(l => l.includes('github') && l.includes('5 tools'))).toBe(true);
  });

  it('info() writes to stdout', () => {
    renderer.info('启动完成');
    expect(output.some(l => l.includes('启动完成'))).toBe(true);
  });

  it('stop() unsubscribes all listeners', () => {
    renderer.stop();
    output = [];
    eventBus.emit('agent.registered', { name: 'test', pid: 9999 });
    expect(output).toHaveLength(0);
  });
});
