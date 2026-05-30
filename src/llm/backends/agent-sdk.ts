import Anthropic from '@anthropic-ai/sdk';
import type { LlmBackend } from '../contract.js';
import type { LlmConfig } from '../types.js';
import { resolveModel } from '../types.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelContentBlock,
  ModelToolCall,
  ModelToolResultBlock,
} from '../../contracts/model.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('agent-sdk');

export interface AgentSdkConfig {
  environmentId: string;
  sessionTtlMs?: number;
}

interface CachedSession {
  agentId: string;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
}

const DEFAULT_SESSION_TTL = 30 * 60 * 1000; // 30 minutes

export class AgentSdkBackend implements LlmBackend {
  private client: Anthropic;
  private config: LlmConfig;
  private envId: string;
  private sessionTtlMs: number;
  private sessions = new Map<string, CachedSession>();

  constructor(config: LlmConfig, agentConfig?: Partial<AgentSdkConfig>) {
    this.client = new Anthropic({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
    this.config = config;
    this.envId = agentConfig?.environmentId ?? '';
    this.sessionTtlMs = agentConfig?.sessionTtlMs ?? DEFAULT_SESSION_TTL;
  }

  async chat(request: ModelRequest, _options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const cacheKey = this.getCacheKey(request);
    const hasToolResults = this.hasToolResults(request.messages);

    let session: CachedSession;
    if (cacheKey && hasToolResults && this.sessions.has(cacheKey)) {
      session = this.sessions.get(cacheKey)!;
      session.lastUsedAt = Date.now();
      await this.sendToolResults(session.sessionId, request);
    } else {
      session = await this.createSession(request);
      if (cacheKey) {
        this.sessions.set(cacheKey, session);
      }
      await this.sendUserMessage(session.sessionId, request);
    }

    const result = await this.streamResponse(session.sessionId, request.id);

    if (result.stopReason !== 'tool_use') {
      this.releaseSession(cacheKey);
    }

    this.evictStale();
    return result;
  }

  getModel(): string {
    return resolveModel(this.config, 'high');
  }

  async cleanup(): Promise<void> {
    for (const [key, session] of this.sessions) {
      await this.archiveAgent(session.agentId);
      this.sessions.delete(key);
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private getCacheKey(request: ModelRequest): string | null {
    if (request.taskId) return `${request.agent}:${request.taskId}`;
    if (request.sessionId) return `${request.agent}:${request.sessionId}`;
    return null;
  }

  private hasToolResults(messages: ModelRequest['messages']): boolean {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return false;
    if (typeof lastMsg.content === 'string') return false;
    return lastMsg.content.some(b => b.type === 'tool_result');
  }

  private async createSession(request: ModelRequest): Promise<CachedSession> {
    const model = resolveModel(this.config, request.modelTier ?? 'high');

    const customTools: Array<{
      type: 'custom';
      name: string;
      description: string;
      input_schema: { type?: 'object'; properties?: Record<string, unknown>; required?: string[] };
    }> = (request.tools ?? []).map((t) => ({
      type: 'custom' as const,
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: (t.inputSchema.properties as Record<string, unknown>) ?? undefined,
        required: (t.inputSchema.required as string[]) ?? undefined,
      },
    }));

    const agent = await this.client.beta.agents.create({
      model,
      name: `task-${request.agent}-${(request.taskId ?? request.id).slice(0, 8)}`,
      system: request.system ?? undefined,
      tools: customTools.length > 0 ? customTools : undefined,
    });

    const session = await this.client.beta.sessions.create({
      agent: agent.id,
      environment_id: this.envId,
    });

    logger.debug({ agentId: agent.id, sessionId: session.id, task: request.taskId }, '创建 Agent SDK 会话');

    return {
      agentId: agent.id,
      sessionId: session.id,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  }

  private async sendUserMessage(sessionId: string, request: ModelRequest): Promise<void> {
    const userContent: Array<{ type: 'text'; text: string }> = [];
    for (const msg of request.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          userContent.push({ type: 'text', text: msg.content });
        } else {
          for (const block of msg.content) {
            if (block.type === 'text') {
              userContent.push({ type: 'text', text: block.text });
            }
          }
        }
      }
    }

    if (userContent.length === 0) {
      userContent.push({ type: 'text', text: '(empty)' });
    }

    await this.client.beta.sessions.events.send(sessionId, {
      events: [{
        type: 'user.message',
        content: userContent,
      }],
    });
  }

  private async sendToolResults(sessionId: string, request: ModelRequest): Promise<void> {
    const lastMsg = request.messages[request.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || typeof lastMsg.content === 'string') return;

    const toolResults = lastMsg.content.filter(
      (b): b is ModelToolResultBlock => b.type === 'tool_result',
    );

    if (toolResults.length === 0) return;

    const events = toolResults.map(tr => ({
      type: 'user.tool_result' as const,
      tool_use_id: tr.toolUseId,
      content: [{ type: 'text' as const, text: tr.content }],
      is_error: tr.isError ?? false,
    }));

    await this.client.beta.sessions.events.send(sessionId, { events });
  }

  private async streamResponse(sessionId: string, requestId: string): Promise<ModelResponse> {
    const contentBlocks: ModelContentBlock[] = [];
    const toolCalls: ModelToolCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    const stream = await this.client.beta.sessions.events.stream(sessionId);
    for await (const event of stream) {
      const eventType = (event as { type: string }).type;

      if (eventType === 'agent.message') {
        const msgEvent = event as { content: Array<{ type: string; text: string }> };
        for (const block of msgEvent.content) {
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: block.text });
          }
        }
      } else if (eventType === 'agent.custom_tool_use') {
        const toolEvent = event as { id: string; name: string; input: Record<string, unknown> };
        toolCalls.push({
          id: toolEvent.id,
          name: toolEvent.name,
          input: toolEvent.input,
        });
        contentBlocks.push({
          type: 'tool_use',
          id: toolEvent.id,
          name: toolEvent.name,
          input: toolEvent.input,
        });
        break;
      } else if (eventType === 'span.model_request_end') {
        const usageEvent = event as { model_usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } };
        const usage = usageEvent.model_usage;
        totalInputTokens += usage.input_tokens;
        totalOutputTokens += usage.output_tokens;
        totalCacheRead += usage.cache_read_input_tokens ?? 0;
        totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
      } else if (eventType === 'session.status_idle' || eventType === 'session.status_terminated') {
        break;
      }
    }

    const textParts = contentBlocks
      .filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text);

    const model = resolveModel(this.config, 'high');

    return {
      requestId,
      content: textParts.join(''),
      contentBlocks,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation,
      },
      model,
    };
  }

  private releaseSession(cacheKey: string | null): void {
    if (!cacheKey) return;
    const session = this.sessions.get(cacheKey);
    if (session) {
      this.sessions.delete(cacheKey);
      this.archiveAgent(session.agentId).catch(() => {});
    }
  }

  private async archiveAgent(agentId: string): Promise<void> {
    try {
      await this.client.beta.agents.archive(agentId);
    } catch {
      logger.debug({ agentId }, '归档 Agent 失败（可能已归档）');
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        this.archiveAgent(session.agentId).catch(() => {});
        logger.debug({ key }, '回收过期 Agent SDK 会话');
      }
    }
  }
}
