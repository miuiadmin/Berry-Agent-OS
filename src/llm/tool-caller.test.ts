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
