import type {
  AgentRuntime,
  AgentEvent,
  AgentEventKind,
  ExecutionTask,
  RuntimeCapabilities,
  ProviderConfig,
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
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(wsUrl, {
        headers: this.buildHeaders(),
      });

      const abortController = new AbortController();
      this.activeExecutions.set(executionId, abortController);

      abortController.signal.addEventListener('abort', () => {
        ws.close(1000, 'Cancelled');
      });

      ws.on('open', () => {
        ws.send(JSON.stringify(task));
      });

      const events: AgentEvent[] = [];
      let done = false;
      let wsError: string | null = null;
      let resolveWait: (() => void) | null = null;

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
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

      ws.on('error', (err) => {
        wsError = err instanceof Error ? err.message : String(err);
        done = true;
        resolveWait?.();
      });

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
