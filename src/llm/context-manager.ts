import type { ModelMessage } from '../contracts/model.js';
import type { LlmClient } from './client.js';
import { compressToolOutputs, buildSummaryPrompt, applyPhase2, type CompressionState, setToolOutputMaxBytes } from './context-compression.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('context-manager');

export interface ContextManagerConfig {
  maxTokenEstimate: number;
  compressionThreshold: number;
  keepRecentTurns: number;
  preserveRecentTokens: number;
  reserved: number;
  charsPerToken: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokenEstimate: 100_000,
  compressionThreshold: 0.75,
  keepRecentTurns: 6,
  preserveRecentTokens: 20_000,
  reserved: 10_000,
  charsPerToken: 3.5,
};

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Compress the given conversation into a structured running summary.
Preserve: user intent, decisions made, key file paths/variables, tool results, established constraints.
Omit: greetings, repetition, verbose tool outputs.
Output in the structured format provided. Use the same language as the conversation.`;

export class ContextManager {
  private config: ContextManagerConfig;
  private state: CompressionState = { previousSummary: null, consecutiveLowSavings: 0 };

  constructor(config?: Partial<ContextManagerConfig> & { toolOutputMaxBytes?: number }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.toolOutputMaxBytes) {
      setToolOutputMaxBytes(config.toolOutputMaxBytes);
    }
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
    return tokens > (this.config.maxTokenEstimate - this.config.reserved) * this.config.compressionThreshold;
  }

  async compress(messages: ModelMessage[], llm: LlmClient): Promise<ModelMessage[]> {
    // Determine tail count: use preserveRecentTokens if it results in more protection than keepRecentTurns
    let tailCount = this.config.keepRecentTurns * 2;
    if (this.config.preserveRecentTokens > 0) {
      let tailTokens = 0;
      for (let i = messages.length - 1; i >= 0 && tailTokens < this.config.preserveRecentTokens; i--) {
        const msg = messages[i];
        const chars = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
        tailTokens += Math.ceil(chars / this.config.charsPerToken);
        tailCount = Math.max(tailCount, messages.length - i);
      }
    }
    if (messages.length <= tailCount) return messages;

    logger.debug({ msgCount: messages.length, estimatedTokens: this.estimateTokens(messages) }, 'compression:start');

    // Phase 1: Prune large/duplicate tool outputs
    const stringified = messages.map(m => ({
      role: m.role as string,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    const pruned = compressToolOutputs(stringified);
    const prunedTokens = Math.ceil(pruned.reduce((s, m) => s + m.content.length, 0) / this.config.charsPerToken);

    // If pruning alone is enough, skip summarization
    if (prunedTokens < this.config.maxTokenEstimate * this.config.compressionThreshold) {
      logger.debug({ prunedTokens, saved: messages.length - pruned.length }, 'compression:pruning-sufficient');
      return pruned.map(m => ({ role: m.role as ModelMessage['role'], content: m.content }));
    }

    // Phase 2: LLM-powered structured summarization
    const headCount = 1;
    const splitAt = pruned.length - tailCount;
    const oldMessages = pruned.slice(headCount, splitAt);

    if (oldMessages.length === 0) return messages;

    const summaryPrompt = buildSummaryPrompt(this.state.previousSummary, oldMessages);

    try {
      const result = await llm.chat(
        [{ role: 'user', content: summaryPrompt }],
        {
          system: SUMMARY_SYSTEM_PROMPT,
          maxTokens: 2048,
          temperature: 0.3,
          purpose: 'context_compression',
          modelTier: 'fast',
        },
      );

      this.state.previousSummary = result.content;

      const compressed = applyPhase2(
        pruned.map(m => ({ role: m.role, content: m.content })),
        result.content,
        headCount,
        tailCount,
      );

      logger.debug({
        before: messages.length,
        after: compressed.length,
        summaryLen: result.content.length,
        hasPreviousSummary: !!this.state.previousSummary,
      }, 'compression:complete');

      return compressed.map(m => ({ role: m.role as ModelMessage['role'], content: m.content }));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'compression:failed, falling back to pruned');
      return pruned.map(m => ({ role: m.role as ModelMessage['role'], content: m.content }));
    }
  }
}
