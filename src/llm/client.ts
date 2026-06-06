import type Database from 'better-sqlite3';
import type { LlmBackend, StreamChunk } from './contract.js';
import { isStreamingBackend } from './contract.js';
import type { LlmConfig } from './types.js';
import { detectThinkingCapability, buildThinkingBody } from './types.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelMessage,
  ModelToolDef,
  ModelContentBlock,
  ModelToolCall,
  ModelStopReason,
  ModelPurpose,
  ModelTier,
} from '../contracts/model.js';
import type { AgentName } from '../contracts/agents.js';
import type { IpcChildChannel } from '../contracts/infrastructure.js';
import type { EventBus } from '../contracts/infrastructure.js';
import { generateText, streamText } from 'ai';
import type { IProviderRegistry } from '../providers/contract.js';
import { createProviderRegistry } from '../providers/registry.js';
import { toAiMessages, toAiTools, mapFinishReason, mapUsage, mapToolCalls, buildContentBlocks, type AiSdkToolCall } from './message-adapter.js';
import { TestBackend } from './backends/test.js';
import { IpcTakeoverBackend } from './backends/ipc-takeover.js';
import { AgentSdkBackend } from './backends/agent-sdk.js';
import { RequestLogger } from './request-logger.js';
import { TokenBudgetController } from './token-budget.js';
import type { BudgetConfig } from './token-budget.js';
import type { ResilienceConfig } from './resilience.js';
import { CircuitBreaker, RateLimiter, ConcurrencySemaphore, getSharedSemaphore } from './resilience.js';
import { classifyLlmError } from './error-classification.js';
import { compileRequest } from './compiler.js';
import { genId } from '../utils/id.js';
import { metrics } from '../observability/metrics.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm-client');

const DEFAULT_MAX_RETRIES = 3;
const STREAM_MAX_RETRIES = 2;

export type { ModelContentBlock, ModelToolCall, ModelStopReason };
export type { ModelMessage as ChatMessage };
export type { ModelToolDef };
export type { StreamChunk };

export type ToolUseBlock = Extract<ModelContentBlock, { type: 'tool_use' }>;
export type TextBlock = Extract<ModelContentBlock, { type: 'text' }>;

export interface ChatOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ModelToolDef[];
  stopSequences?: string[];
  agent?: AgentName;
  purpose?: ModelPurpose;
  modelTier?: ModelTier;
  sessionId?: string;
  taskId?: string;
  correlationId?: string;
  thinkingEnabled?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  contentBlocks: ModelContentBlock[];
  toolCalls: ModelToolCall[];
  stopReason: ModelStopReason;
  inputTokens: number;
  outputTokens: number;
  model: string;
  reasoning?: string;
}

export interface LlmCompletedInfo {
  taskId: string;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreation?: number;
  durationMs: number;
}

export type LlmCompletedHook = (info: LlmCompletedInfo) => void;

export class LlmClient {
  private config: LlmConfig;
  private defaultAgent: string;
  private circuitBreaker: CircuitBreaker;
  private rateLimiter: RateLimiter;
  private concurrencySemaphore: ConcurrencySemaphore;
  private requestLogger: RequestLogger | null;
  private budgetController: TokenBudgetController | null;
  private resilienceConfig: ResilienceConfig;
  // Legacy backend for mock/takeover/agent-sdk modes
  private legacyBackend: LlmBackend | null;
  private llmCompletedHook: LlmCompletedHook | null;
  // New: provider registry for multi-channel model resolution
  private readonly providerRegistry: IProviderRegistry;

  constructor(config: LlmConfig, options: {
    defaultAgent?: string;
    requestLogger?: RequestLogger;
    budgetController?: TokenBudgetController;
    resilienceConfig?: ResilienceConfig;
    legacyBackend?: LlmBackend;
    llmCompletedHook?: LlmCompletedHook;
    providerRegistry?: IProviderRegistry;
  } = {}) {
    this.config = config;
    this.defaultAgent = options.defaultAgent ?? 'unknown';
    this.requestLogger = options.requestLogger ?? null;
    this.budgetController = options.budgetController ?? null;
    this.resilienceConfig = options.resilienceConfig ?? {};
    this.circuitBreaker = new CircuitBreaker(options.resilienceConfig?.circuitBreaker);
    this.rateLimiter = new RateLimiter(options.resilienceConfig?.rateLimiter);
    this.concurrencySemaphore = getSharedSemaphore(options.resilienceConfig?.concurrency);
    this.legacyBackend = options.legacyBackend ?? null;
    this.llmCompletedHook = options.llmCompletedHook ?? null;
    this.providerRegistry = options.providerRegistry ?? createProviderRegistry(config, config.channelsConfig);
  }

  async chat(messages: ModelMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const agentName = options.agent ?? this.defaultAgent;
    const tier: ModelTier = options.modelTier ?? 'default';

    // Delegate to legacy backend for non-live modes
    if (this.legacyBackend) {
      return this.chatViaLegacyBackend(messages, options, agentName);
    }

    const resolved = this.providerRegistry.resolve(tier);
    const modelId = resolved.model.id;
    const model = this.providerRegistry.createModel(tier);

    // Build provider options (thinking, cacheControl) for Anthropic
    const providerOptions = this.buildProviderOptions(modelId, options.thinkingEnabled, resolved.providerKind);

    // Resilience: circuit breaker + rate limiter + concurrency
    if (!this.circuitBreaker.canAttempt()) {
      throw new Error('LLM circuit breaker is open, request rejected');
    }
    await this.rateLimiter.acquire();
    await this.concurrencySemaphore.acquire();

    // Build request metadata for logging
    const requestId = genId('req');
    const request = this.buildRequestMetadata(requestId, messages, options, agentName, tier);

    // Log pending
    if (this.requestLogger) {
      try { this.requestLogger.logPending(request); } catch (e) { logger.debug({ err: e }, 'request log pending failed'); }
    }

    // Budget pre-check
    if (this.budgetController && options.sessionId) {
      const check = this.budgetController.checkBudget('session', options.sessionId);
      if (!check.allowed) {
        throw new Error(check.alert?.message ?? 'Token budget exceeded');
      }
    }

    const t0 = Date.now();
    logger.debug({ model: modelId, messageCount: messages.length, hasTools: !!options.tools?.length, maxTokens: options.maxTokens ?? 4096, agent: agentName, purpose: options.purpose }, 'llm:request');

    // Native path for openai/openai-compatible (supports reasoning_content)
    if (resolved.providerKind === 'openai-compatible' || resolved.providerKind === 'openai') {
      const { chatOpenAICompatible } = await import('./openai-sse-stream.js');
      const maxRetries = this.resilienceConfig.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
      let lastError: unknown;
      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const response = await chatOpenAICompatible({
              baseUrl: resolved.channel.baseUrl ?? '',
              apiKey: resolved.channel.apiKey ?? '',
              model: modelId,
              messages: messages.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : m.content as unknown as Array<Record<string, unknown>>,
              })),
              system: options.system,
              tools: options.tools?.length ? options.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
              maxTokens: options.maxTokens,
              temperature: options.temperature,
              stopSequences: options.stopSequences,
              signal: options.signal,
            });
            response.requestId = requestId;
            this.circuitBreaker.recordSuccess();
            metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'ok' });
            metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
            logger.debug({ model: modelId, stopReason: response.stopReason, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, durationMs: Date.now() - t0, agent: agentName, hasReasoning: !!response.reasoning }, 'llm:complete');
            if (this.requestLogger) { try { this.requestLogger.logCompleted(requestId, response); } catch {} }
            if (this.budgetController) { try { this.budgetController.recordUsage({ sessionId: options.sessionId ?? '', agentName, taskId: options.taskId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cacheReadTokens: response.usage.cacheReadTokens, cacheCreationTokens: 0, model: modelId }); } catch {} }
            if (this.llmCompletedHook) { try { this.llmCompletedHook({ taskId: options.taskId ?? '', agentName, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cacheRead: response.usage.cacheReadTokens, durationMs: Date.now() - t0 }); } catch {} }
            return { content: response.content, contentBlocks: response.contentBlocks, toolCalls: response.toolCalls, stopReason: response.stopReason, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, model: modelId, reasoning: response.reasoning };
          } catch (err) {
            lastError = err;
            const classified = classifyLlmError(err);
            if (!classified.retryable || attempt >= maxRetries) throw err;
            logger.debug({ attempt, error: (err as Error).message }, 'llm:retry');
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        throw lastError;
      } catch (err) {
        this.circuitBreaker.recordFailure();
        metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'error' });
        throw err;
      } finally {
        this.concurrencySemaphore.release();
      }
    }

    const aiMessages = toAiMessages(messages);
    const tools = options.tools?.length ? toAiTools(options.tools) : undefined;

    // Default timeout when caller provides no signal
    const timeoutMs = this.resilienceConfig.defaultTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal = options.signal;
    if (!signal && timeoutMs) {
      const ctrl = new AbortController();
      signal = ctrl.signal;
      timeoutId = setTimeout(() => ctrl.abort(`Request timeout after ${timeoutMs}ms`), timeoutMs);
    }

    let lastError: unknown;
    const maxRetries = this.resilienceConfig.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;

    try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Request aborted');

      try {
        const result = await generateText({
          model,
          system: options.system,
          messages: aiMessages,
          tools,
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.7,
          stopSequences: options.stopSequences,
          abortSignal: signal,
          providerOptions,
          maxRetries: 0, // We handle retries ourselves
        });

        this.circuitBreaker.recordSuccess();

        const usage = mapUsage(result.usage);
        const toolCalls = mapToolCalls(result.toolCalls as AiSdkToolCall[]);
        const stopReason = mapFinishReason(result.finishReason);
        const contentBlocks = buildContentBlocks(
          result.text,
          result.toolCalls as AiSdkToolCall[],
          result.reasoningText ?? undefined,
        );

        const response: ModelResponse = {
          requestId: request.id,
          content: result.text,
          contentBlocks,
          toolCalls,
          stopReason,
          usage,
          model: modelId,
        };

        // Log completion
        if (this.requestLogger) {
          try { this.requestLogger.logCompleted(request.id, response); } catch (e) { logger.debug({ err: e }, 'request log completed failed'); }
        }

        // Record budget
        if (this.budgetController) {
          try {
            this.budgetController.recordUsage({
              sessionId: options.sessionId ?? '',
              agentName,
              taskId: options.taskId,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
              model: modelId,
            });
          } catch (e) { logger.debug({ err: e }, 'budget record failed'); }
        }

        metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'ok' });
        metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
        metrics.histogram('llm_ttft_ms').observe(Date.now() - t0, { agent: agentName });
        logger.debug({ model: modelId, stopReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheReadTokens, durationMs: Date.now() - t0, agent: agentName }, 'llm:complete');

        if (this.llmCompletedHook) {
          try {
            this.llmCompletedHook({
              taskId: options.taskId ?? '',
              agentName,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheRead: usage.cacheReadTokens,
              cacheCreation: usage.cacheCreationTokens,
              durationMs: Date.now() - t0,
            });
          } catch (e) { logger.debug({ err: e }, 'Metrics recording failed'); }
        }

        return {
          content: result.text,
          contentBlocks,
          toolCalls,
          stopReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: modelId,
        };
      } catch (err) {
        lastError = err;
        this.circuitBreaker.recordFailure();

        if (!this.isRetryable(err) || attempt === maxRetries) {
          if (this.requestLogger) {
            try { this.requestLogger.logFailed(request.id, err instanceof Error ? err.message : String(err)); } catch (e) { logger.debug({ err: e }, 'request log failed failed'); }
          }
          metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'error' });
          metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
          throw err;
        }

        const delay = this.getBackoffMs(err, attempt);
        logger.info({ attempt: attempt + 1, delayMs: Math.round(delay), errorType: classifyLlmError(err).type }, 'LLM request retrying');
        await new Promise((r) => setTimeout(r, delay));

        if (!this.circuitBreaker.canAttempt()) {
          throw new Error('LLM circuit breaker is open, request rejected');
        }
      }
    }

    throw lastError;
    } finally {
      this.concurrencySemaphore.release();
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  getModel(): string {
    if (this.legacyBackend) return this.legacyBackend.getModel();
    return this.providerRegistry.resolve('default').model.id;
  }

  supportsStreaming(): boolean {
    if (this.legacyBackend) return isStreamingBackend(this.legacyBackend);
    return true; // AI SDK always supports streaming
  }

  async *chatStream(messages: ModelMessage[], options: ChatOptions = {}): AsyncGenerator<StreamChunk> {
    const agentName = options.agent ?? this.defaultAgent;
    const tier: ModelTier = options.modelTier ?? 'default';

    // Delegate to legacy backend for non-live modes
    if (this.legacyBackend) {
      if (!isStreamingBackend(this.legacyBackend)) {
        throw new Error('Current backend does not support streaming');
      }
      const request = this.buildRequestMetadata(genId('req'), messages, options, agentName, tier);
      yield* this.legacyBackend.chatStream(request, options.signal ? { signal: options.signal } : undefined);
      return;
    }

    const resolved = this.providerRegistry.resolve(tier);
    const modelId = resolved.model.id;
    const providerOptions = this.buildProviderOptions(modelId, options.thinkingEnabled, resolved.providerKind);

    // Budget pre-check
    if (this.budgetController && options.sessionId) {
      const check = this.budgetController.checkBudget('session', options.sessionId);
      if (!check.allowed) {
        throw new Error(check.alert?.message ?? 'Token budget exceeded');
      }
    }

    if (!this.circuitBreaker.canAttempt()) {
      throw new Error('LLM circuit breaker is open, request rejected');
    }
    await this.rateLimiter.acquire();
    await this.concurrencySemaphore.acquire();

    const requestId = genId('req');
    const request = this.buildRequestMetadata(requestId, messages, options, agentName, tier);
    if (this.requestLogger) {
      try { this.requestLogger.logPending(request); } catch (e) { logger.debug({ err: e }, 'request log pending failed'); }
    }

    const t0 = Date.now();
    logger.debug({ model: modelId, messageCount: messages.length, hasTools: !!options.tools?.length, maxTokens: options.maxTokens ?? 4096, agent: agentName, purpose: options.purpose, streaming: true }, 'llm:request');

    // Native SSE stream for openai-compatible (supports reasoning_content natively)
    if (resolved.providerKind === 'openai-compatible' || resolved.providerKind === 'openai') {
      const { streamOpenAICompatible } = await import('./openai-sse-stream.js');
      const timeoutMs = this.resilienceConfig.defaultTimeoutMs;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let signal = options.signal;
      if (!signal && timeoutMs) {
        const ctrl = new AbortController();
        signal = ctrl.signal;
        timeoutId = setTimeout(() => ctrl.abort(`Request timeout after ${timeoutMs}ms`), timeoutMs);
      }
      const maxRetries = this.resilienceConfig.retry?.streamMaxRetries ?? this.resilienceConfig.retry?.maxRetries ?? STREAM_MAX_RETRIES;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw new Error('Request aborted');
        try {
        let lastResponse: import('../contracts/model.js').ModelResponse | undefined;
        for await (const chunk of streamOpenAICompatible({
          baseUrl: resolved.channel.baseUrl ?? '',
          apiKey: resolved.channel.apiKey ?? '',
          model: modelId,
          messages: messages.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : m.content.map(block => {
              if (block.type === 'text') return { type: 'text', text: (block as { text: string }).text };
              if (block.type === 'tool_use') return { type: 'tool_use', id: (block as { id: string }).id, name: (block as { name: string }).name, input: (block as { input: unknown }).input };
              if (block.type === 'tool_result') return { type: 'tool_result', tool_use_id: (block as { toolUseId: string }).toolUseId, content: (block as { content: string }).content };
              return block as unknown as Record<string, unknown>;
            }),
          })) as Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
          system: options.system,
          tools: options.tools?.length ? options.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          stopSequences: options.stopSequences,
          signal,
        })) {
          if (chunk.type === 'message_done') {
            lastResponse = chunk.response;
            lastResponse.requestId = requestId;
          }
          yield chunk;
        }
        this.circuitBreaker.recordSuccess();
        if (lastResponse) {
          const u = lastResponse.usage;
          metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'ok' });
          metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
          logger.debug({ model: modelId, stopReason: lastResponse.stopReason, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: Date.now() - t0, agent: agentName, streaming: true }, 'llm:complete');
          if (this.requestLogger) {
            try { this.requestLogger.logCompleted(requestId, lastResponse); } catch (e) { logger.debug({ err: e }, 'request log completed failed'); }
          }
          if (this.budgetController) {
            try {
              const budgetAlert = this.budgetController.checkPostResponse(
                { sessionId: options.sessionId ?? '', agentName, taskId: options.taskId, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, model: modelId },
              );
              if (budgetAlert && budgetAlert.tier === 'exceeded') {
                logger.info({ sessionId: options.sessionId, tier: budgetAlert.tier }, 'budget:exceeded after stream');
              }
            } catch {}
          }
          if (this.llmCompletedHook) {
            try { this.llmCompletedHook({ taskId: options.taskId ?? '', agentName, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: Date.now() - t0 }); } catch {}
          }
        }
        // Success — exit retry loop
        if (timeoutId) clearTimeout(timeoutId);
        this.concurrencySemaphore.release();
        return;
        } catch (err) {
          lastError = err;
          const classified = classifyLlmError(err);
          if (!classified.retryable || attempt >= maxRetries) {
            this.circuitBreaker.recordFailure();
            metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'error' });
            if (timeoutId) clearTimeout(timeoutId);
            this.concurrencySemaphore.release();
            throw err;
          }
          logger.debug({ attempt, error: (err as Error).message, nextIn: 1000 * (attempt + 1) }, 'llm:retry');
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      // All retries exhausted
      if (timeoutId) clearTimeout(timeoutId);
      this.concurrencySemaphore.release();
      throw lastError;
    }

    const model = this.providerRegistry.createModel(tier);
    const aiMessages = toAiMessages(messages);
    const tools = options.tools?.length ? toAiTools(options.tools) : undefined;
    const maxRetries = this.resilienceConfig.retry?.streamMaxRetries ?? this.resilienceConfig.retry?.maxRetries ?? STREAM_MAX_RETRIES;
    let lastError: unknown;

    // Default timeout when caller provides no signal
    const timeoutMs = this.resilienceConfig.defaultTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal = options.signal;
    if (!signal && timeoutMs) {
      const ctrl = new AbortController();
      signal = ctrl.signal;
      timeoutId = setTimeout(() => ctrl.abort(`Request timeout after ${timeoutMs}ms`), timeoutMs);
    }

    try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Request aborted');

      let hasYielded = false;
      try {
        const result = streamText({
          model,
          system: options.system,
          messages: aiMessages,
          tools,
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.7,
          stopSequences: options.stopSequences,
          abortSignal: signal,
          providerOptions,
          maxRetries: 0,
        });

        const contentBlocks: ModelContentBlock[] = [];
        const toolInputBuffers = new Map<string, { id: string; name: string; json: string }>();
        let reasoningText = '';
        let reasoningActive = false;
        let firstChunkAt: number | undefined;

        for await (const part of result.fullStream) {
          if (signal?.aborted) break;

          switch (part.type) {
            case 'text-delta': {
              if (!firstChunkAt) firstChunkAt = Date.now();
              hasYielded = true;
              if (reasoningActive) { reasoningActive = false; yield { type: 'reasoning_end' }; }
              yield { type: 'text_delta', text: part.text };
              break;
            }

            case 'reasoning-delta':
              if (!firstChunkAt) firstChunkAt = Date.now();
              hasYielded = true;
              if (!reasoningActive) { reasoningActive = true; yield { type: 'reasoning_start' }; }
              reasoningText += part.text;
              yield { type: 'reasoning_delta', text: part.text };
              break;

            case 'tool-input-start':
              hasYielded = true;
              if (reasoningActive) { reasoningActive = false; yield { type: 'reasoning_end' }; }
              toolInputBuffers.set(part.id, { id: part.id, name: part.toolName, json: '' });
              yield { type: 'tool_use_start', id: part.id, name: part.toolName };
              break;

            case 'tool-input-delta': {
              const buf = toolInputBuffers.get(part.id);
              if (buf) {
                buf.json += part.delta;
                yield { type: 'tool_use_delta', id: part.id, partialJson: part.delta };
              }
              break;
            }

            case 'tool-input-end': {
              const buf = toolInputBuffers.get(part.id);
              if (buf) {
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(buf.json || '{}'); } catch (e) { logger.debug({ err: e, toolId: buf.id }, 'Tool input JSON parse failed'); }
                contentBlocks.push({ type: 'tool_use', id: buf.id, name: buf.name, input });
                yield { type: 'tool_use_done', id: buf.id, input };
                toolInputBuffers.delete(part.id);
              }
              yield { type: 'content_block_stop' };
              break;
            }

            case 'tool-call': {
              const existing = contentBlocks.find(
                (b) => b.type === 'tool_use' && b.id === part.toolCallId,
              );
              if (!existing) {
                contentBlocks.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input as Record<string, unknown> });
                yield { type: 'tool_use_done', id: part.toolCallId, input: part.input as Record<string, unknown> };
                yield { type: 'content_block_stop' };
              }
              break;
            }

            case 'error':
              throw part.error instanceof Error ? part.error : new Error(String(part.error));

            case 'abort':
              throw new Error(part.reason ?? 'Stream aborted');

            case 'finish': {
              if (reasoningActive) { reasoningActive = false; yield { type: 'reasoning_end' }; }
              this.circuitBreaker.recordSuccess();
              if (firstChunkAt) {
                metrics.histogram('llm_ttft_ms').observe(firstChunkAt - t0, { agent: agentName });
              }
              const usage = mapUsage(part.totalUsage);
              const stopReason = mapFinishReason(part.finishReason);

              if (reasoningText) {
                contentBlocks.unshift({ type: 'thinking', thinking: reasoningText, signature: '' });
              }

              const textParts = contentBlocks
                .filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text')
                .map((b) => b.text)
                .join('');
              const toolCalls = contentBlocks
                .filter((b): b is Extract<ModelContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
                .map((b) => ({ id: b.id, name: b.name, input: b.input }));

              const finalText = await result.text;

              if (!contentBlocks.some(b => b.type === 'text') && finalText) {
                contentBlocks.push({ type: 'text', text: finalText });
              }

              const response: ModelResponse = {
                requestId: request.id,
                content: finalText,
                contentBlocks,
                toolCalls,
                stopReason,
                usage,
                model: modelId,
              };

              if (this.requestLogger) {
                try { this.requestLogger.logCompleted(request.id, response); } catch (e) { logger.debug({ err: e }, 'request log completed failed'); }
              }
              if (this.budgetController) {
                try {
                  this.budgetController.checkPostResponse({
                    sessionId: options.sessionId ?? '',
                    agentName,
                    taskId: options.taskId,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheCreationTokens: usage.cacheCreationTokens,
                    model: modelId,
                  });
                } catch (e) { logger.debug({ err: e }, 'budget record failed'); }
              }

              metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'ok' });
              metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
              logger.debug({ model: modelId, stopReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheReadTokens, durationMs: Date.now() - t0, agent: agentName, streaming: true, toolCalls: toolCalls.length }, 'llm:complete');

              if (this.llmCompletedHook) {
                try {
                  this.llmCompletedHook({
                    taskId: options.taskId ?? '',
                    agentName,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheRead: usage.cacheReadTokens,
                    cacheCreation: usage.cacheCreationTokens,
                    durationMs: Date.now() - t0,
                  });
                } catch (e) { logger.debug({ err: e }, 'Metrics recording failed'); }
              }

              yield { type: 'message_done', response };
              break;
            }
          }
        }
        return; // Stream completed successfully
      } catch (err) {
        lastError = err;

        // Cannot retry if we already yielded chunks to the consumer
        if (hasYielded || !this.isRetryable(err) || attempt === maxRetries) {
          this.circuitBreaker.recordFailure();
          if (this.requestLogger) {
            try { this.requestLogger.logFailed(request.id, err instanceof Error ? err.message : String(err)); } catch (e) { logger.debug({ err: e }, 'request log failed failed'); }
          }
          metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'error' });
          metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
          throw err;
        }

        this.circuitBreaker.recordFailure();
        const delay = this.getBackoffMs(err, attempt);
        logger.info({ attempt: attempt + 1, delayMs: Math.round(delay), errorType: classifyLlmError(err).type }, 'LLM stream retrying');
        await new Promise((r) => setTimeout(r, delay));

        if (!this.circuitBreaker.canAttempt()) {
          throw new Error('LLM circuit breaker is open, request rejected');
        }
      }
    }

    throw lastError;
    } finally {
      this.concurrencySemaphore.release();
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // === Private helpers ===

  private buildProviderOptions(modelId: string, thinkingEnabled?: boolean, providerKind?: string): Record<string, Record<string, any>> | undefined {
    // Use resolved provider kind from channel if available, otherwise fall back to legacy config
    const provider = providerKind ?? this.config.provider;
    if (provider !== 'anthropic') return undefined;

    const thinkingCap = detectThinkingCapability(modelId);
    const thinking = thinkingEnabled !== false
      ? buildThinkingBody(thinkingCap, true)
      : buildThinkingBody(thinkingCap, false);

    const anthropicOpts: Record<string, any> = {};
    if (thinking) {
      anthropicOpts.thinking = thinking;
    }
    anthropicOpts.cacheControl = { type: 'ephemeral' };

    return { anthropic: anthropicOpts };
  }

  private buildRequestMetadata(
    requestId: string,
    messages: ModelMessage[],
    options: ChatOptions,
    agentName: string,
    tier: ModelTier,
  ): ModelRequest {
    if (options.agent) {
      return compileRequest({
        id: requestId,
        agent: agentName,
        purpose: options.purpose ?? agentName,
        modelTier: tier,
        sessionId: options.sessionId ?? '',
        taskId: options.taskId,
        correlationId: options.correlationId,
        system: options.system,
        messages,
        tools: options.tools,
        options: {
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          stopSequences: options.stopSequences,
          thinkingEnabled: options.thinkingEnabled,
        },
      });
    }

    return {
      id: requestId,
      agent: agentName,
      purpose: options.purpose ?? agentName,
      modelTier: tier,
      mode: 'live',
      backend: 'ai_sdk',
      apiKind: 'standard',
      sessionId: options.sessionId ?? '',
      correlationId: options.correlationId ?? '',
      stepIndex: 0,
      system: options.system,
      messages,
      tools: options.tools,
      options: {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        stopSequences: options.stopSequences,
        thinkingEnabled: options.thinkingEnabled,
      },
      promptHash: '',
      toolsHash: undefined,
    };
  }

  private async chatViaLegacyBackend(messages: ModelMessage[], options: ChatOptions, agentName: string): Promise<ChatResult> {
    const tier: ModelTier = options.modelTier ?? 'default';
    const request = this.buildRequestMetadata(genId('req'), messages, options, agentName, tier);

    // Budget pre-check
    if (this.budgetController && options.sessionId) {
      const check = this.budgetController.checkBudget('session', options.sessionId);
      if (!check.allowed) {
        throw new Error(check.alert?.message ?? 'Token budget exceeded');
      }
    }

    if (this.requestLogger) {
      try { this.requestLogger.logPending(request); } catch (e) { logger.debug({ err: e }, 'request log pending failed'); }
    }

    const t0 = Date.now();
    let response: ModelResponse;
    try {
      response = await this.legacyBackend!.chat(request, options.signal ? { signal: options.signal } : undefined);
      metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'ok' });
    } catch (err) {
      metrics.counter('llm_requests_total').inc({ agent: agentName, status: 'error' });
      metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });
      if (this.requestLogger) {
        try { this.requestLogger.logFailed(request.id, err instanceof Error ? err.message : String(err)); } catch (e) { logger.debug({ err: e }, 'request log failed failed'); }
      }
      throw err;
    }
    metrics.histogram('llm_request_duration_ms').observe(Date.now() - t0, { agent: agentName });

    if (this.requestLogger) {
      try { this.requestLogger.logCompleted(request.id, response); } catch (e) { logger.debug({ err: e }, 'request log completed failed'); }
    }
    if (this.budgetController && response.usage) {
      try {
        this.budgetController.recordUsage({
          sessionId: options.sessionId ?? '',
          agentName,
          taskId: options.taskId,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model: response.model,
        });
      } catch (e) { logger.debug({ err: e }, 'budget record failed'); }
    }

    if (this.llmCompletedHook) {
      try {
        this.llmCompletedHook({
          taskId: options.taskId ?? '',
          agentName,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs: Date.now() - t0,
        });
      } catch (e) { logger.debug({ err: e }, 'Stream cleanup error'); }
    }

    return {
      content: response.content,
      contentBlocks: response.contentBlocks,
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      model: response.model,
    };
  }

  private isRetryable(err: unknown): boolean {
    const classified = classifyLlmError(err);
    return classified.retryable;
  }

  private getBackoffMs(err: unknown, attempt: number): number {
    const classified = classifyLlmError(err);
    if (classified.backoffMs > 0) {
      return Math.min(classified.backoffMs * 2 ** attempt * (0.5 + Math.random() * 0.5), 60000);
    }
    const baseDelay = this.resilienceConfig.retry?.baseDelayMs ?? 1000;
    const maxDelay = this.resilienceConfig.retry?.maxDelayMs ?? 60000;
    return Math.min(baseDelay * 2 ** attempt * (0.5 + Math.random() * 0.5), maxDelay);
  }
}

// === Factory ===

export interface CreateLlmClientOptions {
  db?: Database.Database;
  ipc?: IpcChildChannel;
  eventBus?: EventBus;
  budgetConfig?: Partial<BudgetConfig>;
  resilienceConfig?: ResilienceConfig;
  defaultAgent?: string;
  backendKind?: 'anthropic' | 'claude_agent_sdk';
  /** Optional provider registry for multi-channel model resolution */
  providerRegistry?: IProviderRegistry;
}

export function createLlmClient(config: LlmConfig, options?: CreateLlmClientOptions): LlmClient {
  const mode = config.mode ?? 'live';

  // For non-live modes, use legacy backends
  let legacyBackend: LlmBackend | undefined;

  if (mode === 'takeover' && options?.ipc) {
    legacyBackend = new IpcTakeoverBackend(options.ipc, config.model);
  } else if (mode === 'mock' || mode === 'replay' || mode === 'takeover') {
    legacyBackend = new TestBackend(mode, config.model);
  } else if (options?.backendKind === 'claude_agent_sdk') {
    legacyBackend = new AgentSdkBackend(config);
  }
  // For live mode with standard backend, no legacy backend needed — uses AI SDK directly

  let requestLogger: RequestLogger | undefined;
  let budgetController: TokenBudgetController | undefined;

  if (options?.db) {
    requestLogger = new RequestLogger(options.db);
    budgetController = new TokenBudgetController(
      options.db,
      options.eventBus ?? null,
      options.budgetConfig,
    );
  }

  let llmCompletedHook: LlmCompletedHook | undefined;
  if (options?.ipc) {
    const ipc = options.ipc;
    llmCompletedHook = (info) => {
      ipc.send('task.telemetry', 'core', { kind: 'llm_completed', ...info });
    };
  }

  return new LlmClient(config, {
    defaultAgent: options?.defaultAgent,
    requestLogger,
    budgetController,
    resilienceConfig: {
      ...options?.resilienceConfig,
      // 强制设置请求超时：防止 LLM 调用永远挂死（provider 半死不活/网络断流等场景）
      defaultTimeoutMs: options?.resilienceConfig?.defaultTimeoutMs ?? 60_000,
      concurrency: options?.resilienceConfig?.concurrency ?? { maxConcurrent: config.maxConcurrentRequests ?? 10 },
    },
    legacyBackend,
    llmCompletedHook,
    providerRegistry: options?.providerRegistry ?? createProviderRegistry(config, config.channelsConfig),
  });
}

export function createTestLlmClient(backend: LlmBackend, defaultAgent?: string): LlmClient {
  // Create a minimal config for test clients
  const config: LlmConfig = {
    provider: 'anthropic',
    providers: { anthropic: { apiKey: '', models: {} }, openai: { apiKey: '', models: {} }, 'openai-compatible': { apiKey: '', models: {} } },
    channelsConfig: { channels: [], tiers: {} },
    baseUrl: '',
    apiKey: '',
    model: 'test-model',
    models: {},
    mode: 'mock',
    maxConcurrentRequests: 10,
  };
  return new LlmClient(config, { defaultAgent, legacyBackend: backend, providerRegistry: createProviderRegistry(config, config.channelsConfig) });
}
