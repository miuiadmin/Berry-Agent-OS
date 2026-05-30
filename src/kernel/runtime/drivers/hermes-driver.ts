import type {
  AgentRuntime,
  AgentEvent,
  AgentEventKind,
  ExecutionTask,
  RuntimeCapabilities,
  ProviderConfig,
} from '../../../contracts/agent-runtime.js';
import { EventChannel } from '../event-channel.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('hermes-driver');

export class HermesDriver implements AgentRuntime {
  readonly name = 'Hermes';
  readonly provider = 'hermes' as const;

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private activeExecutions = new Map<string, AbortController>();

  constructor(config: ProviderConfig) {
    if (!config.endpoint) {
      throw new Error('HermesDriver requires endpoint in ProviderConfig');
    }
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      toolInterception: false,
      streaming: true,
      fileAccess: true,
      multiTurn: false,
      resumable: false,
    };
  }

  async *execute(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    const { executionId } = task;
    const abortController = new AbortController();
    this.activeExecutions.set(executionId, abortController);

    yield {
      kind: 'execution_started',
      executionId,
      timestamp: Date.now(),
      data: { provider: 'hermes', endpoint: this.endpoint },
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.endpoint}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          executionId,
          prompt: task.prompt,
          systemPrompt: task.systemPrompt,
          workspacePath: task.workspacePath,
          context: task.context,
          model: task.model,
          timeout: task.timeout,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        yield {
          kind: 'execution_failed',
          executionId,
          timestamp: Date.now(),
          data: { error: `HTTP ${response.status}: ${errorText}` },
        };
        return;
      }

      if (!response.body) {
        yield {
          kind: 'execution_failed',
          executionId,
          timestamp: Date.now(),
          data: { error: 'No response body (SSE stream expected)' },
        };
        return;
      }

      yield* this.consumeSSEStream(response.body, executionId, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted) {
        yield { kind: 'execution_cancelled', executionId, timestamp: Date.now(), data: {} };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ executionId, err }, 'Hermes execution failed');
        yield { kind: 'execution_failed', executionId, timestamp: Date.now(), data: { error: message } };
      }
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const controller = this.activeExecutions.get(executionId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(executionId);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    try {
      await fetch(`${this.endpoint}/cancel/${executionId}`, {
        method: 'POST',
        headers,
      });
    } catch (err) {
      logger.warn({ executionId, err }, 'Failed to send cancel to Hermes');
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(`${this.endpoint}/health`, { headers, signal: AbortSignal.timeout(5000) });
      if (response.ok) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async *consumeSSEStream(
    body: ReadableStream<Uint8Array>,
    executionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal.aborted) break;
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

      if (buffer.startsWith('data: ')) {
        const event = this.parseSSEData(buffer.slice(6), executionId);
        if (event) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSSEData(jsonStr: string, executionId: string): AgentEvent | null {
    if (jsonStr === '[DONE]') return null;

    try {
      const parsed = JSON.parse(jsonStr);
      const kind = parsed.kind as AgentEventKind | undefined;
      if (!kind) return null;

      return {
        kind,
        executionId,
        timestamp: parsed.timestamp ?? Date.now(),
        data: parsed.data ?? {},
      };
    } catch {
      logger.debug({ jsonStr }, 'Failed to parse SSE data');
      return null;
    }
  }
}
