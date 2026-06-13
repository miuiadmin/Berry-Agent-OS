import type {
  AgentRuntime,
  AgentEvent,
  AgentEventKind,
  ExecutionTask,
  RuntimeCapabilities,
  RuntimeProvider,
} from '../../../contracts/agent-runtime.js';
import type { NormalizedExternalEvent } from '../../../contracts/daemon-events.js';
import type { DaemonBridge } from '../../daemon-bridge.js';
import type { EventBus } from '../../event-bus.js';
import type { TaskManager } from '../../task-manager.js';
import { EventChannel } from '../event-channel.js';
import { genId } from '../../../utils/id.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('external-driver');

export class ExternalRuntimeDriver implements AgentRuntime {
  readonly name: string;

  constructor(
    private readonly daemonBridge: DaemonBridge,
    private readonly eventBus: EventBus,
    private readonly taskManager: TaskManager,
    public readonly provider: RuntimeProvider,
  ) {
    this.name = provider === 'claude_code' ? 'Claude Code' : 'OpenCode';
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      toolInterception: false,
      streaming: true,
      fileAccess: true,
      multiTurn: true,
      resumable: true,
      maxContextTokens: 200_000,
    };
  }

  async *execute(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    const channel = new EventChannel<AgentEvent>();
    const taskId = genId('rt');

    yield {
      kind: 'execution_started',
      executionId: task.executionId,
      timestamp: Date.now(),
      data: { taskId, provider: this.provider },
    };

    const unsubs = this.subscribeToTaskEvents(taskId, task.executionId, channel);

    const runtimeName = this.provider === 'claude_code' ? 'claude-code' : 'opencode';
    const dispatched = await this.daemonBridge.dispatch(
      taskId,
      {
        prompt: task.prompt,
        systemPrompt: task.systemPrompt,
        cwd: task.workspacePath,
        model: task.model,
        maxTurns: task.maxTurns,
        timeoutMs: task.timeout,
        resumeSessionId: task.sessionId,
        extraArgs: task.args,
        thinkingLevel: task.thinkingLevel,
        traceId: task.traceId,
      },
      runtimeName,
    );

    if (!dispatched) {
      channel.fail(new Error(`Daemon dispatch failed for runtime: ${runtimeName}`));
    }

    try {
      yield* channel;
    } finally {
      for (const unsub of unsubs) unsub();
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.daemonBridge.cancelTask(executionId, 'Cancelled via runtime interface');
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    if (!this.daemonBridge.isAvailable) {
      return { ok: false, error: 'Daemon not connected' };
    }
    const runtimeName = this.provider === 'claude_code' ? 'claude-code' : 'opencode';
    const available = this.daemonBridge.runtimes.some(r => r.name === runtimeName);
    if (!available) {
      return { ok: false, error: `Runtime ${runtimeName} not available in daemon` };
    }
    return { ok: true };
  }

  private subscribeToTaskEvents(
    taskId: string,
    executionId: string,
    channel: EventChannel<AgentEvent>,
  ): Array<() => void> {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      this.eventBus.on('daemon.task.progress', (payload) => {
        if (payload.taskId !== taskId) return;
        const event = this.mapNormalizedEvent(payload.event, executionId);
        if (event) channel.push(event);
      }),
    );

    unsubs.push(
      this.eventBus.on('daemon.task.completed', (payload) => {
        if (payload.taskId !== taskId) return;
        channel.push({
          kind: 'execution_completed',
          executionId,
          timestamp: Date.now(),
          data: { runtime: payload.runtime, durationMs: payload.durationMs },
        });
        channel.close();
      }),
    );

    unsubs.push(
      this.eventBus.on('daemon.task.failed', (payload) => {
        if (payload.taskId !== taskId) return;
        channel.push({
          kind: 'execution_failed',
          executionId,
          timestamp: Date.now(),
          data: { runtime: payload.runtime, error: payload.error },
        });
        channel.close();
      }),
    );

    return unsubs;
  }

  private mapNormalizedEvent(normalized: NormalizedExternalEvent, executionId: string): AgentEvent | null {
    const timestamp = normalized.timestamp || Date.now();
    const { data } = normalized;

    switch (data.kind) {
      case 'text':
        return { kind: 'text_delta', executionId, timestamp, data: { text: data.text } };

      case 'thinking':
        return { kind: 'thinking_delta', executionId, timestamp, data: { text: data.text } };

      case 'tool_call':
        // tool-trace: 外部 driver 把 daemon 的 tool_call 归一为 tool_running——
        // 携带 name/callId/input 和 timestamp。timestamp 是后续与 tool_completed 配对算 durationMs 的基准。
        logger.debug({ name: data.toolName, callId: data.callId, timestamp }, 'tool-trace: external-driver 产出 tool_running');
        return {
          kind: 'tool_running',
          executionId,
          timestamp,
          data: { name: data.toolName, callId: data.callId, input: data.input },
        };

      case 'tool_result':
        // tool-trace: tool_result 归一为 tool_completed/tool_failed——
        // 与上面 tool_running 的 timestamp 之差即该工具耗时（durationMs）。
        logger.debug({ callId: data.callId, success: data.success, timestamp }, 'tool-trace: external-driver 产出 tool_completed/failed');
        return {
          kind: data.success ? 'tool_completed' : 'tool_failed',
          executionId,
          timestamp,
          data: { callId: data.callId, output: data.output, success: data.success },
        };

      case 'session_start':
        return { kind: 'execution_started', executionId, timestamp, data: { sessionId: data.sessionId } };

      case 'error':
        return { kind: 'execution_failed', executionId, timestamp, data: { error: data.message, code: data.code } };

      case 'usage':
        return { kind: 'progress', executionId, timestamp, data: { ...data } };

      case 'completion':
        return null;

      default:
        return null;
    }
  }
}
