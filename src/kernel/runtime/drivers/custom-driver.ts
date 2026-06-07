import type {
  AgentRuntime,
  AgentEvent,
  AgentEventKind,
  ExecutionTask,
  RuntimeCapabilities,
  ProviderConfig,
  WsClientConnection,
} from '../../../contracts/agent-runtime.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('custom-driver');

export class CustomDriver implements AgentRuntime {
  readonly name: string;
  readonly provider = 'custom' as const;

  private readonly endpoint: string;
  private readonly protocol: 'http' | 'ws';
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  /** 注入的 WebSocket 客户端工厂，避免 kernel 直接依赖 ws 模块 */
  private readonly wsClientFactory: ProviderConfig['wsClientFactory'];
  /** 活跃执行任务及其 AbortController，用于取消和清理 */
  private activeExecutions = new Map<string, AbortController>();

  constructor(config: ProviderConfig) {
    if (!config.endpoint) {
      throw new Error('CustomDriver requires endpoint in ProviderConfig');
    }
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.protocol = config.protocol ?? 'http';
    this.apiKey = config.apiKey;
    this.headers = {};
    this.name = `Custom (${this.endpoint})`;
    // 接收注入的 ws 工厂，若未提供则使用内置的懒加载实现
    this.wsClientFactory = config.wsClientFactory;
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      toolInterception: false,
      streaming: true,
      fileAccess: false,
      multiTurn: false,
      resumable: false,
    };
  }

  async *execute(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    if (this.protocol === 'ws') {
      yield* this.executeViaWebSocket(task);
    } else {
      yield* this.executeViaHttp(task);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const controller = this.activeExecutions.get(executionId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(executionId);
    }

    if (this.protocol === 'http') {
      const headers = this.buildHeaders();
      try {
        await fetch(`${this.endpoint}/cancel/${executionId}`, {
          method: 'POST',
          headers,
        });
      } catch (err) {
        logger.warn({ executionId, err }, 'Failed to send cancel to custom endpoint');
      }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async *executeViaHttp(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    const { executionId } = task;
    const abortController = new AbortController();
    this.activeExecutions.set(executionId, abortController);

    yield {
      kind: 'execution_started',
      executionId,
      timestamp: Date.now(),
      data: { provider: 'custom', endpoint: this.endpoint, protocol: 'http' },
    };

    try {
      const response = await fetch(`${this.endpoint}/execute`, {
        method: 'POST',
        headers: { ...this.buildHeaders(), 'Accept': 'text/event-stream' },
        body: JSON.stringify(task),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: `HTTP ${response.status}: ${errorText}` } };
        return;
      }

      if (!response.body) {
        yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: 'No response body' } };
        return;
      }

      yield* this.consumeSSEStream(response.body, executionId);
    } catch (err) {
      if (abortController.signal.aborted) {
        yield { kind: 'execution_cancelled', executionId, timestamp: Date.now(), data: {} };
      } else {
        yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: err instanceof Error ? err.message : String(err) } };
      }
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * 通过 WebSocket 协议执行任务。
   * 使用注入的 wsClientFactory 创建连接，避免 kernel 直接 import('ws')。
   */
  private async *executeViaWebSocket(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    const { executionId } = task;

    yield {
      kind: 'execution_started',
      executionId,
      timestamp: Date.now(),
      data: { provider: 'custom', endpoint: this.endpoint, protocol: 'ws' },
    };

    const wsUrl = this.endpoint.replace(/^http/, 'ws') + '/execute';

    try {
      // 通过注入的工厂创建 WS 连接，而非直接 import('ws')
      const ws: WsClientConnection = this.wsClientFactory
        ? await this.wsClientFactory(wsUrl, this.buildHeaders())
        : await this.createFallbackConnection(wsUrl);

      const abortController = new AbortController();
      this.activeExecutions.set(executionId, abortController);

      abortController.signal.addEventListener('abort', () => {
        ws.close(1000, 'Cancelled');
      });

      ws.on('open', () => {
        ws.send(JSON.stringify(task));
      });

      /** 累积的事件队列，用于 AsyncGenerator yield */
      const events: AgentEvent[] = [];
      let done = false;
      let wsError: string | null = null;
      let resolveWait: (() => void) | null = null;

      ws.on('message', (data: unknown) => {
        try {
          const raw = typeof data === 'string' ? data : (data as { toString(): string }).toString();
          const parsed = JSON.parse(raw);
          const event: AgentEvent = {
            kind: parsed.kind,
            executionId,
            timestamp: parsed.timestamp ?? Date.now(),
            data: parsed.data ?? {},
          };
          events.push(event);
          resolveWait?.();
        } catch {
          logger.debug('Failed to parse WebSocket message');
        }
      });

      ws.on('close', () => {
        done = true;
        resolveWait?.();
      });

      ws.on('error', (err: unknown) => {
        wsError = err instanceof Error ? err.message : String(err);
        done = true;
        resolveWait?.();
      });

      // 事件循环：优先 yield 已累积的事件，等待新事件或连接关闭
      while (true) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>(resolve => { resolveWait = resolve; });
        resolveWait = null;
      }

      if (wsError) {
        yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: wsError } };
      }

      this.activeExecutions.delete(executionId);
    } catch (err) {
      yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: err instanceof Error ? err.message : String(err) } };
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * 后备方案：当未注入 wsClientFactory 时，动态加载默认实现。
   * 默认实现在 src/lib/ws-client-factory.ts（不属于 kernel 目录），
   * 仅在此处按需引用，保持 kernel 对 ws 模块的零直接依赖。
   */
  private async createFallbackConnection(url: string): Promise<WsClientConnection> {
    const { createWsConnection } = await import('../../../lib/ws-client-factory.js');
    return createWsConnection(url, this.buildHeaders());
  }

  private async *consumeSSEStream(
    body: ReadableStream<Uint8Array>,
    executionId: string,
  ): AsyncGenerator<AgentEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const event = this.parseSSEData(line.slice(6), executionId);
            if (event) yield event;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSSEData(jsonStr: string, executionId: string): AgentEvent | null {
    if (jsonStr === '[DONE]') return null;
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        kind: parsed.kind as AgentEventKind,
        executionId,
        timestamp: parsed.timestamp ?? Date.now(),
        data: parsed.data ?? {},
      };
    } catch {
      return null;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
