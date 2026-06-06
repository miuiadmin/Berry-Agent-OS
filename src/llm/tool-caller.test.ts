import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TestBackend } from './backends/test.js';
import { createTestLlmClient } from './client.js';
import { runToolLoop, type ToolCallRecord } from './tool-caller.js';
import { registerTool } from '../tools/index.js';
import type { LlmBackend, StreamChunk, StreamingLlmBackend } from './contract.js';
import type { ModelRequest, ModelResponse } from '../contracts/model.js';

describe('runToolLoop permission token closure', () => {
  it('拒绝没有 permission token 的工具调用', async () => {
    registerTestTool('token_test_no_token');
    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [{ id: 'tu_1', name: 'token_test_no_token', input: {} }] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 1000 },
      requestPermission: async () => ({ allowed: true }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: (record) => records.push(record),
    });

    expect(result.finalContent).toBe('done');
    expect(records[0].isError).toBe(true);
    expect(records[0].result).toContain('缺少 permission token');
  });

  it('拒绝 token 校验失败的工具调用', async () => {
    registerTestTool('token_test_invalid');
    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [{ id: 'tu_1', name: 'token_test_invalid', input: {} }] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 1000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk_bad' }),
      validatePermission: async () => ({ allowed: false, reason: '绑定上下文不匹配' }),
      consumePermission: async () => {},
      auditTool: (record) => records.push(record),
    });

    expect(records[0].permissionToken).toBe('ptk_bad');
    expect(records[0].result).toContain('绑定上下文不匹配');
  });

  it('拒绝缺少 token 校验/消费器的工具调用', async () => {
    registerTestTool('token_test_missing_validator');
    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [{ id: 'tu_1', name: 'token_test_missing_validator', input: {} }] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 1000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk_unchecked' }),
      validatePermission: undefined as never,
      consumePermission: undefined as never,
      auditTool: (record) => records.push(record),
    });

    expect(records[0].permissionToken).toBe('ptk_unchecked');
    expect(records[0].isError).toBe(true);
    expect(records[0].result).toContain('缺少 permission token 校验/消费器');
  });

  it('成功执行后消费 permission token 并写入审计记录', async () => {
    registerTestTool('token_test_ok');
    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [{ id: 'tu_1', name: 'token_test_ok', input: { ok: true } }] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    const consumed: string[] = [];
    await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 1000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk_ok' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async (tokenId) => { consumed.push(tokenId); },
      auditTool: (record) => records.push(record),
    });

    expect(records[0].permissionToken).toBe('ptk_ok');
    expect(records[0].result).toBe('tool ok');
    expect(consumed).toEqual(['ptk_ok']);
  });
});

function registerTestTool(name: string): void {
  registerTool({
    name,
    description: 'test tool',
    inputSchema: z.object({}).passthrough(),
    dangerLevel: 'safe',
    async execute() {
      return { content: 'tool ok' };
    },
  });
}

class StreamingTestBackend implements StreamingLlmBackend {
  private chunks: StreamChunk[][] = [];

  setStreamResponses(responses: StreamChunk[][]): void {
    this.chunks = responses;
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    throw new Error('Should not be called when streaming');
  }

  getModel(): string { return 'test-streaming'; }

  async *chatStream(_request: ModelRequest): AsyncGenerator<StreamChunk> {
    const response = this.chunks.shift();
    if (!response) throw new Error('No mock stream responses left');
    for (const chunk of response) {
      yield chunk;
    }
  }
}

describe('runToolLoop streaming', () => {
  it('calls onChunk with text deltas when streaming is supported', async () => {
    const backend = new StreamingTestBackend();
    backend.setStreamResponses([
      [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'message_done', response: {
          requestId: 'req_1',
          content: 'Hello world',
          contentBlocks: [{ type: 'text', text: 'Hello world' }],
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'test',
        }},
      ],
    ]);

    const chunks: string[] = [];
    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 5000 },
      onChunk: (text) => chunks.push(text),
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk_1' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: () => {},
    });

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.finalContent).toBe('Hello world');
  });

  it('falls back to non-streaming when onChunk is not provided', async () => {
    const backend = new TestBackend('mock');
    backend.setMockResponses([{ content: 'non-streamed response' }]);

    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 3, timeoutMs: 5000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk_1' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: () => {},
    });

    expect(result.finalContent).toBe('non-streamed response');
  });
});

describe('parallel tool execution', () => {
  it('多个 parallelizable 工具并发执行（总时间 < 串行时间）', async () => {
    // 注册两个 parallelizable 工具，各自 sleep 50ms
    registerTool({
      name: 'parallel_a',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() {
        await new Promise(r => setTimeout(r, 50));
        return { content: 'result_a' };
      },
    });
    registerTool({
      name: 'parallel_b',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() {
        await new Promise(r => setTimeout(r, 50));
        return { content: 'result_b' };
      },
    });

    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [
        { id: 'tu_a', name: 'parallel_a', input: {} },
        { id: 'tu_b', name: 'parallel_b', input: {} },
      ] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    const start = Date.now();
    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 5, timeoutMs: 5000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: (record) => records.push(record),
    });
    const elapsed = Date.now() - start;

    expect(result.finalContent).toBe('done');
    expect(records).toHaveLength(2);
    expect(records[0].result).toBe('result_a');
    expect(records[1].result).toBe('result_b');
    // 并行执行：两个 50ms 工具应在 ~50-80ms 完成，串行则 ~100ms+
    expect(elapsed).toBeLessThan(95);
  });

  it('混合 parallel 和 serial 工具正确分 batch', async () => {
    registerTool({
      name: 'par_1',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() { return { content: 'p1' }; },
    });
    registerTool({
      name: 'par_2',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() { return { content: 'p2' }; },
    });
    registerTool({
      name: 'serial_1',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      async execute() { return { content: 's1' }; },
    });

    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [
        { id: 'tu_1', name: 'par_1', input: {} },
        { id: 'tu_2', name: 'par_2', input: {} },
        { id: 'tu_3', name: 'serial_1', input: {} },
      ] },
      { content: 'final' },
    ]);

    const records: ToolCallRecord[] = [];
    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 10, timeoutMs: 5000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: (record) => records.push(record),
    });

    expect(result.finalContent).toBe('final');
    // 按原始顺序：par_1, par_2, serial_1
    expect(records.map(r => r.result)).toEqual(['p1', 'p2', 's1']);
  });

  it('并行批中一个失败不影响其他', async () => {
    registerTool({
      name: 'par_ok',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() { return { content: 'ok' }; },
    });
    registerTool({
      name: 'par_fail',
      description: 'test',
      inputSchema: z.object({}).passthrough(),
      dangerLevel: 'safe',
      parallelizable: true,
      async execute() { throw new Error('boom'); },
    });

    const backend = new TestBackend('mock');
    backend.setMockResponses([
      { content: '', toolCalls: [
        { id: 'tu_ok', name: 'par_ok', input: {} },
        { id: 'tu_fail', name: 'par_fail', input: {} },
      ] },
      { content: 'done' },
    ]);

    const records: ToolCallRecord[] = [];
    const result = await runToolLoop({
      llm: createTestLlmClient(backend),
      messages: [{ role: 'user', content: 'run' }],
      systemPrompt: 'test',
      tools: [],
      config: { maxCalls: 5, timeoutMs: 5000 },
      requestPermission: async () => ({ allowed: true, tokenId: 'ptk' }),
      validatePermission: async () => ({ allowed: true }),
      consumePermission: async () => {},
      auditTool: (record) => records.push(record),
    });

    expect(result.finalContent).toBe('done');
    expect(records[0].result).toBe('ok');
    expect(records[0].isError).toBe(false);
    expect(records[1].result).toContain('boom');
    expect(records[1].isError).toBe(true);
  });
});
