import type { EventBus } from '../contracts/infrastructure.js';

export interface SdkStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface NormalizerContext {
  taskId: string;
  agentName: string;
  sessionId: string;
}

export class SdkEventNormalizer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly ctx: NormalizerContext,
  ) {}

  handle(event: SdkStreamEvent): void {
    switch (event.type) {
      case 'agent.message':
        this.handleMessage(event);
        break;
      case 'agent.custom_tool_use':
        this.handleToolUse(event);
        break;
      case 'span.model_request_end':
        this.handleModelRequestEnd(event);
        break;
      case 'session.status_idle':
        this.handleIdle();
        break;
      case 'session.status_terminated':
        this.handleTerminated();
        break;
    }
  }

  private handleMessage(event: SdkStreamEvent): void {
    const content = event.content as Array<{ type: string; text: string }>;
    const text = content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') ?? '';

    if (text) {
      this.eventBus.emit('task.progress', {
        taskId: this.ctx.taskId,
        message: text.slice(0, 200),
        payload: { source: 'agent_sdk', full: text },
      });
    }
  }

  private handleToolUse(event: SdkStreamEvent): void {
    this.eventBus.emit('task.progress', {
      taskId: this.ctx.taskId,
      message: `使用工具: ${event.name as string}`,
      payload: {
        source: 'agent_sdk',
        toolName: event.name,
        toolId: event.id,
      },
    });
  }

  private handleModelRequestEnd(event: SdkStreamEvent): void {
    const usage = event.model_usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | undefined;

    if (!usage) return;

    const totalTokens = usage.input_tokens + usage.output_tokens;
    this.eventBus.emit('task.progress', {
      taskId: this.ctx.taskId,
      message: `模型请求完成 (${totalTokens} tokens)`,
      payload: {
        source: 'agent_sdk',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }

  private handleIdle(): void {
    this.eventBus.emit('task.progress', {
      taskId: this.ctx.taskId,
      message: 'SDK session idle',
      payload: { source: 'agent_sdk', status: 'idle' },
    });
  }

  private handleTerminated(): void {
    this.eventBus.emit('task.progress', {
      taskId: this.ctx.taskId,
      message: 'SDK session terminated',
      payload: { source: 'agent_sdk', status: 'terminated' },
    });
  }
}
