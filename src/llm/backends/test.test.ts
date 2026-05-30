import { describe, it, expect } from 'vitest';
import { TestBackend, type MockResponse } from './test.js';
import type { ModelRequest } from '../../contracts/model.js';

function makeRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    id: 'req_test_001',
    agent: 'conversation',
    purpose: 'conversation',
    modelTier: 'default',
    mode: 'mock',
    backend: 'test',
    apiKind: 'standard',
    sessionId: 'ses_test',
    correlationId: 'cor_test',
    stepIndex: 0,
    messages: [{ role: 'user', content: 'hello' }],
    options: { maxTokens: 1024 },
    promptHash: 'testhash',
    ...overrides,
  };
}

describe('TestBackend - mock mode', () => {
  it('returns default empty response when no mocks are set', async () => {
    const backend = new TestBackend('mock');
    const res = await backend.chat(makeRequest());
    expect(res.requestId).toBe('req_test_001');
    expect(res.content).toBe('');
    expect(res.stopReason).toBe('end_turn');
  });

  it('returns mock response in order', async () => {
    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: 'first' },
      { content: 'second' },
    ]);

    const r1 = await backend.chat(makeRequest({ id: 'r1' }));
    const r2 = await backend.chat(makeRequest({ id: 'r2' }));

    expect(r1.content).toBe('first');
    expect(r2.content).toBe('second');
  });

  it('returns tool_use stop reason when toolCalls present', async () => {
    const backend = new TestBackend('mock');
    backend.addMockResponse({
      content: '',
      toolCalls: [{ id: 'tu_1', name: 'read_file', input: { path: '/tmp' } }],
    });

    const res = await backend.chat(makeRequest());
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('read_file');
  });
});

describe('TestBackend - replay mode', () => {
  it('replays responses in sequence', async () => {
    const backend = new TestBackend('replay');
    backend.setMockResponses([
      { content: 'replay-1' },
      { content: 'replay-2' },
    ]);

    const r1 = await backend.chat(makeRequest({ id: 'r1' }));
    const r2 = await backend.chat(makeRequest({ id: 'r2' }));

    expect(r1.content).toBe('replay-1');
    expect(r2.content).toBe('replay-2');
  });

  it('throws when replay responses exhausted', async () => {
    const backend = new TestBackend('replay');
    backend.setMockResponses([{ content: 'only-one' }]);

    await backend.chat(makeRequest());
    await expect(backend.chat(makeRequest())).rejects.toThrow('Replay 模式已耗尽');
  });
});

describe('TestBackend - takeover mode', () => {
  it('queues requests and resolves when responded', async () => {
    const backend = new TestBackend('takeover');

    const chatPromise = backend.chat(makeRequest({ id: 'req_tk_1' }));
    expect(backend.getPendingTakeoverRequests()).toHaveLength(1);

    const success = backend.respondToTakeover('req_tk_1', {
      content: 'external response',
      contentBlocks: [{ type: 'text', text: 'external response' }],
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
      model: 'external-model',
    });
    expect(success).toBe(true);

    const res = await chatPromise;
    expect(res.content).toBe('external response');
    expect(res.requestId).toBe('req_tk_1');
  });

  it('rejectTakeover causes chat to throw', async () => {
    const backend = new TestBackend('takeover');

    const chatPromise = backend.chat(makeRequest({ id: 'req_tk_2' }));
    backend.rejectTakeover('req_tk_2', new Error('CI timeout'));

    await expect(chatPromise).rejects.toThrow('CI timeout');
  });

  it('returns false when request id not found', () => {
    const backend = new TestBackend('takeover');
    expect(backend.respondToTakeover('nonexistent', {} as any)).toBe(false);
    expect(backend.rejectTakeover('nonexistent', new Error())).toBe(false);
  });
});
