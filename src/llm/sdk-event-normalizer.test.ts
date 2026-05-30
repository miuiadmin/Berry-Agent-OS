import { describe, it, expect, beforeEach } from 'vitest';
import { SdkEventNormalizer } from './sdk-event-normalizer.js';
import { EventBus } from '../kernel/event-bus.js';
import type { SdkStreamEvent } from './sdk-event-normalizer.js';

describe('SdkEventNormalizer', () => {
  let eventBus: EventBus;
  let normalizer: SdkEventNormalizer;
  let emitted: Array<{ event: string; data: any }>;

  beforeEach(() => {
    eventBus = new EventBus();
    emitted = [];
    eventBus.on('task.progress', (data) => {
      emitted.push({ event: 'task.progress', data });
    });
    normalizer = new SdkEventNormalizer(eventBus, {
      taskId: 'task_1',
      agentName: 'code',
      sessionId: 'ses_1',
    });
  });

  it('agent.message emits task.progress with truncated text', () => {
    const longText = 'x'.repeat(300);
    normalizer.handle({
      type: 'agent.message',
      content: [{ type: 'text', text: longText }],
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.taskId).toBe('task_1');
    expect(emitted[0].data.message).toHaveLength(200);
    expect(emitted[0].data.payload.source).toBe('agent_sdk');
    expect(emitted[0].data.payload.full).toBe(longText);
  });

  it('agent.message with short text emits full text', () => {
    normalizer.handle({
      type: 'agent.message',
      content: [{ type: 'text', text: 'hello' }],
    });

    expect(emitted[0].data.message).toBe('hello');
  });

  it('agent.message with empty content does not emit', () => {
    normalizer.handle({
      type: 'agent.message',
      content: [],
    });

    expect(emitted).toHaveLength(0);
  });

  it('agent.custom_tool_use emits with tool name', () => {
    normalizer.handle({
      type: 'agent.custom_tool_use',
      name: 'read_file',
      id: 'tu_123',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.message).toContain('read_file');
    expect(emitted[0].data.payload.toolName).toBe('read_file');
    expect(emitted[0].data.payload.toolId).toBe('tu_123');
  });

  it('span.model_request_end emits token usage', () => {
    normalizer.handle({
      type: 'span.model_request_end',
      model_usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.message).toContain('150');
    expect(emitted[0].data.payload.inputTokens).toBe(100);
    expect(emitted[0].data.payload.outputTokens).toBe(50);
    expect(emitted[0].data.payload.cacheRead).toBe(20);
    expect(emitted[0].data.payload.cacheCreation).toBe(10);
  });

  it('span.model_request_end with no usage does not emit', () => {
    normalizer.handle({
      type: 'span.model_request_end',
      model_usage: undefined,
    });

    expect(emitted).toHaveLength(0);
  });

  it('session.status_idle emits idle event', () => {
    normalizer.handle({ type: 'session.status_idle' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.payload.status).toBe('idle');
  });

  it('session.status_terminated emits terminated event', () => {
    normalizer.handle({ type: 'session.status_terminated' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.payload.status).toBe('terminated');
  });

  it('unknown event type does not emit', () => {
    normalizer.handle({ type: 'unknown.event' });
    expect(emitted).toHaveLength(0);
  });
});
