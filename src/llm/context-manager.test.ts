import { describe, it, expect, vi } from 'vitest';
import { ContextManager } from './context-manager.js';
import type { ModelMessage } from '../contracts/model.js';
import type { LlmClient, ChatResult } from './client.js';

function mockLlm(summaryContent = '摘要内容'): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: summaryContent,
      contentBlocks: [{ type: 'text', text: summaryContent }],
      toolCalls: [],
      stopReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 50,
      model: 'test',
    } satisfies ChatResult),
    getModel: () => 'test',
  } as unknown as LlmClient;
}

describe('ContextManager', () => {
  it('estimates tokens from message lengths', () => {
    const cm = new ContextManager({ charsPerToken: 4 });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello world' }, // 11 chars
      { role: 'assistant', content: 'hi there' }, // 8 chars
    ];
    // (11 + 8) / 4 = 4.75 → 5
    expect(cm.estimateTokens(messages)).toBe(5);
  });

  it('reports needsCompression when over threshold', () => {
    const cm = new ContextManager({ maxTokenEstimate: 100, compressionThreshold: 0.5, charsPerToken: 1 });
    const shortMsgs: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    expect(cm.needsCompression(shortMsgs)).toBe(false);

    const longContent = 'x'.repeat(60);
    const longMsgs: ModelMessage[] = [{ role: 'user', content: longContent }];
    expect(cm.needsCompression(longMsgs)).toBe(true);
  });

  it('compresses old messages into a summary', async () => {
    // Low maxTokenEstimate forces Phase 2 (LLM summarization)
    // keepRecentTurns=1 → tailCount=2
    const cm = new ContextManager({
      keepRecentTurns: 1,
      maxTokenEstimate: 10,
      compressionThreshold: 0.1,
      charsPerToken: 1,
    });
    const llm = mockLlm('这是一段对话摘要');

    const messages: ModelMessage[] = [
      { role: 'user', content: '消息1' },
      { role: 'assistant', content: '回复1' },
      { role: 'user', content: '消息2' },
      { role: 'assistant', content: '回复2' },
      { role: 'user', content: '消息3' },
      { role: 'assistant', content: '回复3' },
      { role: 'user', content: '最近的消息' },
      { role: 'assistant', content: '最近的回复' },
    ];

    const compressed = await cm.compress(messages, llm);

    // applyPhase2: 1 head + 2 summary + 2 tail = 5
    expect(compressed.length).toBe(5);
    // head: first message preserved
    expect(compressed[0].content).toBe('消息1');
    // summary pair injected by applyPhase2
    expect(compressed[1].content).toContain('[context compacted]');
    expect(compressed[1].content).toContain('这是一段对话摘要');
    expect(compressed[2].content).toContain('[context compacted');
    // tail: last turn preserved
    expect(compressed[3].content).toBe('最近的消息');
    expect(compressed[4].content).toBe('最近的回复');
    expect(llm.chat).toHaveBeenCalledOnce();
  });

  it('returns messages as-is when count <= tail threshold', async () => {
    // keepRecentTurns=6 → tailCount=12, these 2 messages are well below
    const cm = new ContextManager({ keepRecentTurns: 6 });
    const llm = mockLlm();
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const result = await cm.compress(messages, llm);
    expect(result).toEqual(messages);
    expect(llm.chat).not.toHaveBeenCalled();
  });
});
