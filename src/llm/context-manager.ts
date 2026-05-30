import type { ModelMessage } from '../contracts/model.js';
import type { LlmClient } from './client.js';

export interface ContextManagerConfig {
  maxTokenEstimate: number;
  compressionThreshold: number;
  keepRecentMessages: number;
  charsPerToken: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokenEstimate: 100_000,
  compressionThreshold: 0.75,
  keepRecentMessages: 10,
  charsPerToken: 3.5,
};

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要助手。将以下对话历史压缩为一段简洁的摘要。
保留关键信息：用户意图、重要决策、工具调用结果、已建立的上下文。
省略寒暄和重复信息。用中文输出。`;

export class ContextManager {
  private config: ContextManagerConfig;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  estimateTokens(messages: ModelMessage[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block) totalChars += (block as { text: string }).text.length;
          else if ('content' in block) totalChars += ((block as { content: string }).content ?? '').length;
          else totalChars += JSON.stringify(block).length;
        }
      }
    }
    return Math.ceil(totalChars / this.config.charsPerToken);
  }

  needsCompression(messages: ModelMessage[]): boolean {
    const tokens = this.estimateTokens(messages);
    return tokens > this.config.maxTokenEstimate * this.config.compressionThreshold;
  }

  async compress(messages: ModelMessage[], llm: LlmClient): Promise<ModelMessage[]> {
    if (messages.length <= this.config.keepRecentMessages) {
      return messages;
    }

    const splitAt = messages.length - this.config.keepRecentMessages;
    const oldMessages = messages.slice(0, splitAt);
    const recentMessages = messages.slice(splitAt);

    const summary = await this.summarize(oldMessages, llm);

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[对话历史摘要]\n${summary}`,
    };

    return [summaryMessage, ...recentMessages];
  }

  private async summarize(messages: ModelMessage[], llm: LlmClient): Promise<string> {
    const transcript = messages.map((m) => {
      const role = m.role === 'user' ? '用户' : '助手';
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content).slice(0, 500);
      return `${role}: ${content}`;
    }).join('\n');

    const truncated = transcript.slice(0, 8000);

    const result = await llm.chat(
      [{ role: 'user', content: `请摘要以下对话：\n\n${truncated}` }],
      {
        system: SUMMARY_SYSTEM_PROMPT,
        maxTokens: 1024,
        temperature: 0.3,
        purpose: 'context_compression',
        modelTier: 'fast',
      },
    );

    return result.content;
  }
}
