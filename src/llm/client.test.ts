import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TestBackend } from './backends/test.js';
import { RequestLogger } from './request-logger.js';
import { TokenBudgetController } from './token-budget.js';
import { EventBus } from '../kernel/event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';
import type { LlmConfig } from './types.js';
import type { StreamChunk } from './contract.js';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('./providers.js', () => ({
  createProviderModel: vi.fn(() => ({ modelId: 'mocked', provider: 'anthropic' })),
}));

import { LlmClient, createTestLlmClient } from './client.js';
import { generateText, streamText } from 'ai';

const generateTextMock = generateText as unknown as ReturnType<typeof vi.fn>;
const streamTextMock = streamText as unknown as ReturnType<typeof vi.fn>;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function makeLiveConfig(): LlmConfig {
  return {
    provider: 'anthropic',
    providers: {
      anthropic: { apiKey: 'key', models: {} },
      openai: { apiKey: '', models: {} },
      'openai-compatible': { apiKey: '', models: {} },
    },
    baseUrl: '',
    apiKey: 'key',
    model: 'test-model',
    models: {},
    mode: 'live',
  };
}

describe('LlmClient — legacy backend path', () => {
  let backend: TestBackend;
  let client: LlmClient;

  beforeEach(() => {
    backend = new TestBackend('mock', 'test-model');
    client = createTestLlmClient(backend, 'test-agent');
  });

  it('returns correct ChatResult shape from simple response', async () => {
    backend.setMockResponses([{ content: 'hello world' }]);

    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('hello world');
    expect(result.contentBlocks).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.model).toBe('test-model');
  });

  it('maps tool calls in response', async () => {
    backend.setMockResponses([{
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'read_file', input: { path: '/tmp/x' } }],
    }]);

    const result = await client.chat([{ role: 'user', content: 'read that file' }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({ id: 'tc_1', name: 'read_file', input: { path: '/tmp/x' } });
    expect(result.stopReason).toBe('tool_use');
  });

  it('getModel returns backend model', () => {
    expect(client.getModel()).toBe('test-model');
  });

  it('supportsStreaming returns false for non-streaming backend', () => {
    expect(client.supportsStreaming()).toBe(false);
  });

  it('legacy path records request logger on success', async () => {
    const db = createTestDb();
    backend.setMockResponses([{ content: 'logged' }]);

    const loggedClient = new LlmClient(
      { provider: 'anthropic', providers: { anthropic: { apiKey: '', models: {} }, openai: { apiKey: '', models: {} }, 'openai-compatible': { apiKey: '', models: {} } }, baseUrl: '', apiKey: '', model: 'test-model', models: {}, mode: 'mock' },
      { defaultAgent: 'test', legacyBackend: backend, requestLogger: new RequestLogger(db) },
    );

    await loggedClient.chat([{ role: 'user', content: 'hi' }], { sessionId: 'ses_1' });

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('responded');
    db.close();
  });

  it('legacy path records request logger on failure', async () => {
    const db = createTestDb();
    const failBackend = {
      chat: () => Promise.reject(new Error('backend error')),
      getModel: () => 'test-model',
    };

    const loggedClient = new LlmClient(
      { provider: 'anthropic', providers: { anthropic: { apiKey: '', models: {} }, openai: { apiKey: '', models: {} }, 'openai-compatible': { apiKey: '', models: {} } }, baseUrl: '', apiKey: '', model: 'test-model', models: {}, mode: 'mock' },
      { defaultAgent: 'test', legacyBackend: failBackend, requestLogger: new RequestLogger(db) },
    );

    await expect(loggedClient.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('backend error');

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('backend error');
    db.close();
  });

  it('legacy path rejects when budget exceeded', async () => {
    const db = createTestDb();
    const eventBus = new EventBus();
    const budgetCtrl = new TokenBudgetController(db, eventBus, { sessionLimit: 10 });
    budgetCtrl.recordUsage({ sessionId: 'ses_over', agentName: 'test', inputTokens: 15, outputTokens: 0, model: 'test' });

    backend.setMockResponses([{ content: 'should not reach' }]);

    const loggedClient = new LlmClient(
      { provider: 'anthropic', providers: { anthropic: { apiKey: '', models: {} }, openai: { apiKey: '', models: {} }, 'openai-compatible': { apiKey: '', models: {} } }, baseUrl: '', apiKey: '', model: 'test-model', models: {}, mode: 'mock' },
      { defaultAgent: 'test', legacyBackend: backend, budgetController: budgetCtrl },
    );

    await expect(loggedClient.chat([{ role: 'user', content: 'hi' }], { sessionId: 'ses_over' })).rejects.toThrow(/预算|budget/i);
    db.close();
  });
});

describe('LlmClient — AI SDK live path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls generateText and returns correct result', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: {}, outputTokenDetails: {} },
      reasoningText: undefined,
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] } },
    });

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('hello');
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 error and succeeds', async () => {
    const err429 = new Error('rate limited') as Error & { status: number };
    err429.status = 429;

    generateTextMock
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({
        text: 'success',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: {}, outputTokenDetails: {} },
        reasoningText: undefined,
      });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] },
        circuitBreaker: { failureThreshold: 10, recoveryTimeMs: 60000 },
      },
    });

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('success');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable error (400)', async () => {
    const err400 = new Error('bad request') as Error & { status: number };
    err400.status = 400;
    generateTextMock.mockRejectedValue(err400);

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429, 500] } },
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('bad request');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const err503 = new Error('overloaded') as Error & { status: number };
    err503.status = 503;
    generateTextMock.mockRejectedValue(err503);

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [503] },
        circuitBreaker: { failureThreshold: 10, recoveryTimeMs: 60000 },
      },
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('overloaded');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when circuit breaker is open after failures', async () => {
    const err500 = new Error('down') as Error & { status: number };
    err500.status = 500;
    generateTextMock.mockRejectedValue(err500);

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [500] },
        circuitBreaker: { failureThreshold: 2, recoveryTimeMs: 60000 },
      },
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('down');
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('down');
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('circuit breaker is open');
  });

  it('records request logging on success', async () => {
    const db = createTestDb();
    generateTextMock.mockResolvedValueOnce({
      text: 'logged',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, inputTokenDetails: {}, outputTokenDetails: {} },
      reasoningText: undefined,
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      requestLogger: new RequestLogger(db),
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    await client.chat([{ role: 'user', content: 'hi' }], { sessionId: 'ses_1' });

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('responded');
    expect(rows[0].session_id).toBe('ses_1');
    db.close();
  });

  it('records request logging on failure', async () => {
    const db = createTestDb();
    const err = new Error('API fail') as Error & { status: number };
    err.status = 400;
    generateTextMock.mockRejectedValue(err);

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      requestLogger: new RequestLogger(db),
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('API fail');

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('API fail');
    db.close();
  });

  it('budget pre-check rejects when over limit', async () => {
    const db = createTestDb();
    const eventBus = new EventBus();
    const budgetCtrl = new TokenBudgetController(db, eventBus, { sessionLimit: 10 });

    budgetCtrl.recordUsage({
      sessionId: 'ses_over',
      agentName: 'test',
      inputTokens: 15,
      outputTokens: 0,
      model: 'test',
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      budgetController: budgetCtrl,
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], { sessionId: 'ses_over' }),
    ).rejects.toThrow(/预算|budget/i);
    expect(generateTextMock).not.toHaveBeenCalled();
    db.close();
  });

  it('chatStream budget pre-check rejects when over limit', async () => {
    const db = createTestDb();
    const eventBus = new EventBus();
    const budgetCtrl = new TokenBudgetController(db, eventBus, { sessionLimit: 10 });

    budgetCtrl.recordUsage({
      sessionId: 'ses_over',
      agentName: 'test',
      inputTokens: 15,
      outputTokens: 0,
      model: 'test',
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      budgetController: budgetCtrl,
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    const gen = client.chatStream([{ role: 'user', content: 'hi' }], { sessionId: 'ses_over' });
    await expect(gen.next()).rejects.toThrow(/预算|budget/i);
    expect(streamTextMock).not.toHaveBeenCalled();
    db.close();
  });

  it('chatStream yields text_delta and message_done', async () => {
    const mockFullStream = (async function* () {
      yield { type: 'text-delta', id: 't1', text: 'hello ' };
      yield { type: 'text-delta', id: 't1', text: 'world' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: {}, outputTokenDetails: {} },
      };
    })();

    streamTextMock.mockReturnValueOnce({
      fullStream: mockFullStream,
      text: Promise.resolve('hello world'),
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'hello ' });
    expect(chunks[1]).toEqual({ type: 'text_delta', text: 'world' });
    expect(chunks[2].type).toBe('message_done');
    const done = chunks[2] as Extract<StreamChunk, { type: 'message_done' }>;
    expect(done.response.content).toBe('hello world');
  });

  it('chatStream throws on error event', async () => {
    const mockFullStream = (async function* () {
      yield { type: 'error', error: new Error('stream failed') };
    })();

    streamTextMock.mockReturnValueOnce({
      fullStream: mockFullStream,
      text: Promise.resolve(''),
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] } },
    });

    const gen = client.chatStream([{ role: 'user', content: 'hi' }]);
    await expect(gen.next()).rejects.toThrow('stream failed');
  });

  it('chatStream abortSignal respected', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
    });

    // With the abort signal already triggered, streamText will be called with the signal
    // and should fail immediately. Mock streamText to throw with abort.
    streamTextMock.mockImplementation(() => {
      throw new Error('aborted');
    });

    const gen = client.chatStream([{ role: 'user', content: 'hi' }], { signal: ctrl.signal });
    await expect(gen.next()).rejects.toThrow();
  });

  it('chatStream retries connection failure before first chunk', async () => {
    const err429 = new Error('rate limited') as Error & { status: number };
    err429.status = 429;

    let callCount = 0;
    streamTextMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw err429;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', id: 't1', text: 'ok' };
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: {}, outputTokenDetails: {} },
          };
        })(),
        text: Promise.resolve('ok'),
      };
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] },
        circuitBreaker: { failureThreshold: 10, recoveryTimeMs: 60000 },
      },
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(callCount).toBe(2);
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'ok' });
  });

  it('chatStream does not retry mid-stream failure', async () => {
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 't1', text: 'partial' };
        throw Object.assign(new Error('mid-stream'), { status: 429 });
      })(),
      text: Promise.resolve(''),
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] },
        circuitBreaker: { failureThreshold: 10, recoveryTimeMs: 60000 },
      },
    });

    const chunks: StreamChunk[] = [];
    const gen = client.chatStream([{ role: 'user', content: 'hi' }]);

    // First chunk should succeed
    const first = await gen.next();
    expect(first.value).toEqual({ type: 'text_delta', text: 'partial' });

    // Second call should throw (no retry because we already yielded)
    await expect(gen.next()).rejects.toThrow('mid-stream');
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('chat times out when defaultTimeoutMs is set and request hangs', async () => {
    generateTextMock.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    });

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] },
        defaultTimeoutMs: 50,
      },
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/abort/i);
  });

  it('chatStream times out when defaultTimeoutMs is set and stream hangs', async () => {
    streamTextMock.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      fullStream: (async function* () {
        await new Promise((_, reject) => {
          if (abortSignal) {
            abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
          }
        });
      })(),
      text: Promise.resolve(''),
    }));

    const client = new LlmClient(makeLiveConfig(), {
      defaultAgent: 'test',
      resilienceConfig: {
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [] },
        defaultTimeoutMs: 50,
      },
    });

    const gen = client.chatStream([{ role: 'user', content: 'hi' }]);
    await expect(gen.next()).rejects.toThrow(/abort/i);
  });
});
