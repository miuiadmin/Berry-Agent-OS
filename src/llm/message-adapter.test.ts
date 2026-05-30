import { describe, it, expect } from 'vitest';
import {
  toAiMessages,
  mapFinishReason,
  mapUsage,
  mapToolCalls,
  buildContentBlocks,
  toAiTools,
} from './message-adapter.js';
import type { ModelMessage, ModelContentBlock } from '../contracts/model.js';

describe('toAiMessages', () => {
  it('converts simple string user message', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('converts simple string assistant message', () => {
    const messages: ModelMessage[] = [{ role: 'assistant', content: 'hi' }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('converts system message from string', () => {
    const messages: ModelMessage[] = [{ role: 'system', content: 'you are helpful' }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{ role: 'system', content: 'you are helpful' }]);
  });

  it('converts system message from content blocks (extracts text)', () => {
    const messages: ModelMessage[] = [{
      role: 'system',
      content: [
        { type: 'text', text: 'system ' },
        { type: 'text', text: 'prompt' },
      ],
    }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{ role: 'system', content: 'system prompt' }]);
  });

  it('converts assistant message with tool_use blocks', () => {
    const messages: ModelMessage[] = [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'test' } },
      ],
    }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool-call', toolCallId: 'tu_1', toolName: 'search', input: { query: 'test' } },
      ],
    }]);
  });

  it('resolves toolName in tool_result from prior assistant message', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_abc', name: 'read_file', input: { path: '/tmp/x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu_abc', content: 'file contents here' },
        ],
      },
    ];
    const result = toAiMessages(messages);
    const toolMsg = result.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg!.content as any[])[0].toolName).toBe('read_file');
  });

  it('uses error-text output type for error tool results', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'run_cmd', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu_1', content: 'command failed', isError: true },
        ],
      },
    ];
    const result = toAiMessages(messages);
    const toolMsg = result.find(m => m.role === 'tool');
    expect((toolMsg!.content as any[])[0].output).toEqual({ type: 'error-text', value: 'command failed' });
  });

  it('uses text output type for successful tool results', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'ls', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu_2', content: 'file1.ts\nfile2.ts' }],
      },
    ];
    const result = toAiMessages(messages);
    const toolMsg = result.find(m => m.role === 'tool');
    expect((toolMsg!.content as any[])[0].output).toEqual({ type: 'text', value: 'file1.ts\nfile2.ts' });
  });

  it('falls back to unknown when toolName cannot be resolved', () => {
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tu_orphan', content: 'result' },
      ],
    }];
    const result = toAiMessages(messages);
    const toolMsg = result.find(m => m.role === 'tool');
    expect((toolMsg!.content as any[])[0].toolName).toBe('unknown');
  });

  it('drops thinking blocks from assistant messages', () => {
    const messages: ModelMessage[] = [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal thought', signature: 'sig123' },
        { type: 'text', text: 'visible response' },
      ],
    }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'visible response' }],
    }]);
  });

  it('produces separate tool and user messages when both present', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_x', name: 'calc', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu_x', content: '42' },
          { type: 'text', text: 'and also this' },
        ],
      },
    ];
    const result = toAiMessages(messages);
    expect(result).toHaveLength(3); // assistant + tool + user
    expect(result[1].role).toBe('tool');
    expect(result[2].role).toBe('user');
    expect((result[2].content as any[])[0].text).toBe('and also this');
  });

  it('handles empty assistant content blocks as empty string', () => {
    const messages: ModelMessage[] = [{
      role: 'assistant',
      content: [] as ModelContentBlock[],
    }];
    const result = toAiMessages(messages);
    expect(result).toEqual([{ role: 'assistant', content: '' }]);
  });
});

describe('mapFinishReason', () => {
  it('maps stop to end_turn', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
  });

  it('maps tool-calls to tool_use', () => {
    expect(mapFinishReason('tool-calls')).toBe('tool_use');
  });

  it('maps length to max_tokens', () => {
    expect(mapFinishReason('length')).toBe('max_tokens');
  });

  it('maps unknown values to end_turn', () => {
    expect(mapFinishReason('error' as any)).toBe('end_turn');
    expect(mapFinishReason('other' as any)).toBe('end_turn');
    expect(mapFinishReason('content-filter' as any)).toBe('end_turn');
  });
});

describe('mapUsage', () => {
  it('maps all fields correctly', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 10 },
      outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
    };
    expect(mapUsage(usage)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
    });
  });

  it('handles undefined values gracefully', () => {
    const usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    };
    expect(mapUsage(usage)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });
});

describe('mapToolCalls', () => {
  it('maps tool calls correctly using input field', () => {
    const toolCalls = [
      { toolCallId: 'tc_1', toolName: 'search', input: { q: 'hello' } },
      { toolCallId: 'tc_2', toolName: 'read', input: { path: '/tmp' } },
    ];
    expect(mapToolCalls(toolCalls)).toEqual([
      { id: 'tc_1', name: 'search', input: { q: 'hello' } },
      { id: 'tc_2', name: 'read', input: { path: '/tmp' } },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(mapToolCalls([])).toEqual([]);
  });
});

describe('buildContentBlocks', () => {
  it('builds text-only blocks', () => {
    const blocks = buildContentBlocks('hello', []);
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('builds tool-call-only blocks', () => {
    const blocks = buildContentBlocks('', [
      { toolCallId: 'tc_1', toolName: 'search', input: { q: 'test' } },
    ]);
    expect(blocks).toEqual([
      { type: 'tool_use', id: 'tc_1', name: 'search', input: { q: 'test' } },
    ]);
  });

  it('builds reasoning + text + tool_use in correct order', () => {
    const blocks = buildContentBlocks('response', [
      { toolCallId: 'tc_1', toolName: 'run', input: {} },
    ], 'internal reasoning');
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'internal reasoning', signature: '' },
      { type: 'text', text: 'response' },
      { type: 'tool_use', id: 'tc_1', name: 'run', input: {} },
    ]);
  });

  it('returns empty array when no content', () => {
    const blocks = buildContentBlocks('', []);
    expect(blocks).toEqual([]);
  });

  it('omits reasoning block when undefined', () => {
    const blocks = buildContentBlocks('text', [], undefined);
    expect(blocks).toEqual([{ type: 'text', text: 'text' }]);
  });
});

describe('toAiTools', () => {
  it('converts tool definitions to AI SDK ToolSet', () => {
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ];
    const result = toAiTools(tools);
    expect(result).toHaveProperty('read_file');
    expect(result.read_file).toHaveProperty('description', 'Read a file');
    expect(result.read_file).toHaveProperty('inputSchema');
  });

  it('handles multiple tools', () => {
    const tools = [
      { name: 'tool_a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'tool_b', description: 'B', inputSchema: { type: 'object' } },
    ];
    const result = toAiTools(tools);
    expect(Object.keys(result)).toEqual(['tool_a', 'tool_b']);
  });
});
