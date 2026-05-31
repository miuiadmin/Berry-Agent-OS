import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CreateMessageRequestParams,
  CreateMessageResult,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LlmClient, ChatOptions } from '../llm/index.js';
import type { ModelMessage, ModelContentBlock } from '../contracts/model.js';
import type { McpSamplingConfig } from './contract.js';
import type { EventBus } from '../contracts/infrastructure.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-sampling');

// ─── Sliding Window Rate Limiter ───────────────────────────────

class SlidingWindowLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ─── Sampling Handler ──────────────────────────────────────────

export class SamplingHandler {
  private readonly limiter: SlidingWindowLimiter;
  private toolRoundCount = 0;

  constructor(
    private readonly serverName: string,
    private readonly config: McpSamplingConfig,
    private readonly llmClient: LlmClient,
    private readonly eventBus?: EventBus,
  ) {
    this.limiter = new SlidingWindowLimiter(config.maxRpm, 60_000);
  }

  async handleCreateMessage(params: CreateMessageRequestParams): Promise<CreateMessageResult> {
    if (!this.limiter.tryAcquire()) {
      throw new Error(`采样速率超限 (${this.config.maxRpm} rpm)`);
    }

    if (this.toolRoundCount >= this.config.maxToolRounds) {
      throw new Error(`工具链深度超限 (max ${this.config.maxToolRounds})`);
    }

    const messages = convertSamplingMessages(params.messages);
    const options: ChatOptions = {
      system: params.systemPrompt,
      maxTokens: Math.min(params.maxTokens, this.config.maxTokensCap),
      temperature: params.temperature,
      stopSequences: params.stopSequences,
      purpose: 'mcp_sampling',
      agent: 'mcp_sampling',
    };

    if (this.config.model) {
      options.modelTier = 'default';
    }

    logger.debug({ serverName: this.serverName, maxTokens: options.maxTokens }, 'MCP sampling 请求');
    this.eventBus?.emit('mcp.sampling_request', { serverName: this.serverName, model: this.config.model });

    const result = await this.llmClient.chat(messages, options);

    if (result.stopReason === 'tool_use') {
      this.toolRoundCount++;
    } else {
      this.toolRoundCount = 0;
    }

    return convertToSamplingResult(result.contentBlocks, result.stopReason, result.model);
  }

  register(client: Client): void {
    if (!this.config.enabled) return;

    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      return this.handleCreateMessage(request.params as CreateMessageRequestParams);
    });

    logger.debug({ serverName: this.serverName }, 'Sampling handler 已注册');
  }

  resetDepth(): void {
    this.toolRoundCount = 0;
  }
}

// ─── Message Conversion: MCP → agent ──────────────────────

function convertSamplingMessages(messages: SamplingMessage[]): ModelMessage[] {
  return messages.map(msg => {
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    const contentBlocks: ModelContentBlock[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          contentBlocks.push({ type: 'text', text: block.text });
          break;
        case 'tool_use':
          contentBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
          break;
        case 'tool_result':
          contentBlocks.push({
            type: 'tool_result',
            toolUseId: block.toolUseId,
            content: extractToolResultText(block.content),
            isError: block.isError,
          });
          break;
      }
    }

    if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
      return { role: msg.role, content: contentBlocks[0].text };
    }

    return { role: msg.role, content: contentBlocks };
  });
}

function extractToolResultText(content: unknown): string {
  if (!content || !Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string }) => c.type === 'text')
    .map((c: { text?: string }) => c.text ?? '')
    .join('\n');
}

// ─── Result Conversion: agent → MCP ───────────────────────

function convertToSamplingResult(
  contentBlocks: ModelContentBlock[],
  stopReason: string,
  model: string,
): CreateMessageResult {
  const mcpContent = contentBlocks
    .filter(b => b.type === 'text')
    .map(b => ({ type: 'text' as const, text: (b as { text: string }).text }));

  const content = mcpContent.length > 0
    ? mcpContent[0]
    : { type: 'text' as const, text: '' };

  return {
    role: 'assistant',
    content,
    model,
    stopReason: mapStopReason(stopReason),
  };
}

function mapStopReason(reason: string): CreateMessageResult['stopReason'] {
  switch (reason) {
    case 'end_turn': return 'endTurn';
    case 'max_tokens': return 'maxTokens';
    case 'stop_sequence': return 'stopSequence';
    case 'tool_use': return 'toolUse';
    default: return 'endTurn';
  }
}
