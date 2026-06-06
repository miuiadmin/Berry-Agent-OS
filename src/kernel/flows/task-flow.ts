import type { IpcMessage, IpcMessageType } from '../types.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { AgentProgress } from '../agent-progress.js';
import type { TaskManager } from '../task-manager.js';
import type {
  TaskAcknowledgePayload,
  TaskStartedPayload,
  TaskProgressPayload,
  TaskTelemetryPayload,
  AgentTaskResultPayload,
} from '../../contracts/tasks.js';
import type { AgentAskUserPayload } from '../../contracts/routing.js';
import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import { getEventBus } from '../event-bus.js';

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

export interface TaskFlowDeps {
  taskManager: TaskManager;
  delegationManager: DelegationManager;
  sessionManager: SessionManager;
  agentProgress: AgentProgress | null;
  registry: AgentRegistry;
  agentManager: AgentManager;
  streamingFlusher?: import('../streaming-flusher.js').StreamingFlusher;
}

export function setupTaskProgressHandler(agentIpc: AgentIpc, agentName: string, deps: TaskFlowDeps): void {
  agentIpc.onMessage('task.progress', (msg: IpcMessage) => {
    const { taskId, summary } = msg.payload as TaskProgressPayload;
    const task = taskId ? deps.taskManager.getTask(taskId) : undefined;
    if (task && deps.agentProgress) {
      deps.agentProgress.report({
        taskId,
        sessionId: task.session_id,
        source: msg.from,
        message: summary,
        payload: { from: msg.from },
      });
    }
  });
}

export function setupTaskAcknowledgeHandlers(agentIpc: AgentIpc, deps: TaskFlowDeps): void {
  agentIpc.onMessage('task.acknowledge', (msg: IpcMessage) => {
    const { taskId } = msg.payload as TaskAcknowledgePayload;
    if (taskId) deps.delegationManager.acknowledge(taskId);
  });

  agentIpc.onMessage('task.started', (msg: IpcMessage) => {
    const { taskId } = msg.payload as TaskStartedPayload;
    if (taskId) deps.delegationManager.acknowledge(taskId);
  });
}

export function setupTaskTelemetryHandler(agentIpc: AgentIpc, deps: TaskFlowDeps): void {
  agentIpc.onMessage('task.telemetry', (msg: IpcMessage) => {
    const payload = msg.payload as TaskTelemetryPayload;
    switch (payload.kind) {
      case 'text_delta': {
        if (!payload.taskId) return;
        let pending: PendingRequest | null | undefined;
        const entry = deps.delegationManager.get(payload.taskId);
        if (entry) {
          // 跳过已完成 delegation 的迟到 text_delta（handoff 后旧 agent 的残留消息）
          if (entry.state === 'completed' || entry.state === 'failed') break;
          deps.delegationManager.recordOutput(payload.taskId, { delegationId: payload.taskId, kind: 'text_delta', data: { text: payload.text } });
          pending = deps.sessionManager.getPending(entry.correlationId);
        } else {
          pending = deps.sessionManager.findPendingByTaskId(payload.taskId);
        }
        // 实时同步到 pending，重连时可从中恢复已积累的文本
        if (pending) {
          pending.draftResponse = (pending.draftResponse ?? '') + payload.text;
          // 通知 flusher 定期持久化到 SQLite（前端断连恢复用）
          deps.streamingFlusher?.onTextAccumulated(payload.taskId, pending.draftResponse, pending.reasoning);
        }
        // H1/H2/H3: 不再直写 socket。改为 emit 到 EventBus，由 StreamDispatcher 派发给所有 transport 订阅者。
        // 没有 pending 也照样 emit（可能用于其它 transport / 重连补发 / 持久化 logger）。
        getEventBus().emit('stream.text_delta', {
          taskId: payload.taskId,
          sessionId: pending?.sessionId ?? entry?.sessionId ?? '',
          text: payload.text,
          correlationId: entry?.correlationId,
        });
        break;
      }
      case 'reasoning_delta': {
        if (!payload.taskId) return;
        const rEntry = deps.delegationManager.get(payload.taskId);
        const rPending = rEntry
          ? deps.sessionManager.getPending(rEntry.correlationId)
          : deps.sessionManager.findPendingByTaskId(payload.taskId);
        if (rPending) {
          rPending.reasoning = (rPending.reasoning ?? '') + payload.text;
        }
        // H1/H2: 兜底断连恢复 —— reasoning 累加到 pending 后，写入 flusher（事实源）
        if (rPending) {
          deps.streamingFlusher?.onTextAccumulated(
            payload.taskId,
            rPending.draftResponse ?? '',
            rPending.reasoning ?? '',
          );
        }
        // 改为 emit，由 StreamDispatcher fan-out 到所有 transport 订阅者
        getEventBus().emit('stream.reasoning_delta', {
          taskId: payload.taskId,
          sessionId: rPending?.sessionId ?? rEntry?.sessionId ?? '',
          text: payload.text,
          correlationId: rEntry?.correlationId,
        });
        break;
      }
      case 'llm_completed': {
        if (payload.taskId) {
          const entry = deps.delegationManager.get(payload.taskId);
          if (entry) {
            deps.delegationManager.recordOutput(payload.taskId, {
              delegationId: payload.taskId,
              kind: 'usage',
              data: { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens },
            });
          }
        }
        getEventBus().emit('llm.request.completed', {
          taskId: payload.taskId,
          agentName: payload.agentName,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          cacheRead: payload.cacheRead,
          cacheCreation: payload.cacheCreation,
          durationMs: payload.durationMs,
        });
        break;
      }
      case 'tool_result': {
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        if (!entry) return;
        deps.delegationManager.recordOutput(payload.taskId, {
          delegationId: payload.taskId,
          kind: payload.isError ? 'tool_error' : 'tool_result',
          data: { toolName: payload.toolName },
        });
        break;
      }
      case 'tool_call': {
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        let pending: PendingRequest | null | undefined;
        if (entry) {
          pending = deps.sessionManager.getPending(entry.correlationId);
        } else {
          pending = deps.sessionManager.findPendingByTaskId(payload.taskId);
        }
        // H1/H2: 不再直写 socket。改为 emit，由 StreamDispatcher 派发到 transport 订阅者。
        getEventBus().emit('stream.tool_call', {
          taskId: payload.taskId,
          sessionId: pending?.sessionId ?? entry?.sessionId ?? '',
          toolName: payload.toolName,
          input: payload.input,
          result: payload.result,
          isError: payload.isError,
          durationMs: payload.durationMs,
          correlationId: entry?.correlationId,
        });
        break;
      }
      case 'uncertainty': {
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        if (!entry) return;
        deps.delegationManager.reportUncertainty(payload.taskId, payload.reason);
        break;
      }
    }
  });
}

export function setupModuleTaskResultHandler(
  agentIpc: AgentIpc,
  agentName: string,
  deps: TaskFlowDeps,
  onForegroundResult: (result: AgentTaskResultPayload, entry: { correlationId: string; sessionId: string }, agent: string) => void,
): void {
  agentIpc.onMessage('agent.task.result', (msg: IpcMessage) => {
    const result = msg.payload as AgentTaskResultPayload;

    if (result.ok) {
      deps.taskManager.complete(result.taskId, result.outputPayload ?? {});
    } else {
      deps.taskManager.fail(result.taskId, result.error ?? '任务失败');
    }

    const entry = deps.delegationManager.get(result.taskId);
    if (entry) {
      onForegroundResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, agentName);
    }
  });

  agentIpc.onMessage('agent.ask_user', (msg: IpcMessage) => {
    const payload = msg.payload as AgentAskUserPayload;
    const orchestratorAgent = deps.registry.requireRole('orchestrator');
    const brain = deps.agentManager.getAgent(orchestratorAgent.manifest.name);
    if (brain) {
      brain.ipc.send('agent.ask_user', orchestratorAgent.manifest.name, payload, msg.correlationId ?? msg.id);
    }
  });
}
