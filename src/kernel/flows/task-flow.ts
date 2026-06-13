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
import { getLogger } from '../../utils/logger.js';
import { getOrCreateBlockCollector } from '../block-collector.js';

/**
 * 工具调用计时链路 trace 日志器。
 * 追踪 durationMs 从 task.telemetry → stream.tool_call 的流转，
 * 定位「委派给其他智能体时工具调用计时显示 N/A」时耗时在哪一层丢失。
 * grep `tool-trace` 可看全链路。
 */
const logger = getLogger('task-flow');

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
        // 对话内联（doc 22 Phase C）：文本经 collector → emit stream.block（单一事件族，前端气泡从 TextBlock 渲染）。
        // 粒度 stream.text_delta 已删——消灭双写；pending.draftResponse 累积 + flusher 仍保留（持久化事实源）。
        {
          const sid = pending?.sessionId ?? entry?.sessionId ?? '';
          if (sid) {
            getOrCreateBlockCollector(payload.taskId, sid, entry?.correlationId).onTextDelta(payload.text);
          }
        }
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
        // 对话内联（doc 22 Phase C）：推理经 collector → emit stream.block thinking（单一事件族，前端从 thinking block 渲染）。
        // 粒度 stream.reasoning_delta 已删——消灭双写；rPending.reasoning 累积 + flusher 仍保留（持久化事实源）。
        {
          const sid = rPending?.sessionId ?? rEntry?.sessionId ?? '';
          if (sid) {
            getOrCreateBlockCollector(payload.taskId, sid, rEntry?.correlationId).onReasoningDelta(payload.text);
          }
        }
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
        // tool-trace: tool_result 变体契约本身无 durationMs 字段（见 contracts/tasks.ts:37），仅记录到达
        logger.debug({ taskId: payload.taskId, toolName: payload.toolName, isError: payload.isError, source: msg.from }, 'tool-trace: recv task.telemetry tool_result');
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        if (!entry) return;
        deps.delegationManager.recordOutput(payload.taskId, {
          delegationId: payload.taskId,
          kind: payload.isError ? 'tool_error' : 'tool_result',
          data: { toolName: payload.toolName },
        });
        // P1-1: 流式契约补全 — tool_result 也通过 EventBus 推送给前端
        getEventBus().emit('stream.tool_result', {
          taskId: payload.taskId,
          sessionId: entry.sessionId,
          toolName: payload.toolName,
          isError: payload.isError,
          correlationId: entry.correlationId,
        });
        // tool-trace: emit stream.tool_result 未透传 durationMs — payload 的 tool_result 变体无此字段，
        // daemon 路径（外部 agent）的工具耗时在此处无法传递给前端（已知盲点，待彻底修复）
        logger.debug({ taskId: payload.taskId, toolName: payload.toolName }, 'tool-trace: emit stream.tool_result（无 durationMs 字段）');
        break;
      }
      case 'tool_call': {
        // tool-trace: 追踪 agent 上报的 tool_call 是否携带 durationMs（计时源头）
        logger.debug({ taskId: payload.taskId, toolName: payload.toolName, durationMs: payload.durationMs, hasDurationMs: payload.durationMs != null, source: msg.from }, 'tool-trace: recv task.telemetry tool_call');
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        let pending: PendingRequest | null | undefined;
        if (entry) {
          pending = deps.sessionManager.getPending(entry.correlationId);
        } else {
          pending = deps.sessionManager.findPendingByTaskId(payload.taskId);
        }
        // 对话内联（doc 22 Phase C）：工具调用经 collector → emit stream.block tool（单一事件族，出生即终态
        // 带 input/result/durationMs，前端从 tool block 渲染）。粒度 stream.tool_call 已删——消灭双写。
        {
          const sid = pending?.sessionId ?? entry?.sessionId ?? '';
          if (sid) {
            getOrCreateBlockCollector(payload.taskId, sid, entry?.correlationId).onToolCall({
              toolName: payload.toolName,
              input: payload.input,
              result: payload.result,
              isError: payload.isError,
              durationMs: payload.durationMs,
            });
          }
        }
        // tool-trace: tool_call → onToolCall → stream.block tool（durationMs 随 block 透传到前端）
        logger.debug({ taskId: payload.taskId, toolName: payload.toolName, durationMs: payload.durationMs }, 'tool-trace: tool_call → onToolCall → stream.block');
        break;
      }
      case 'uncertainty': {
        if (!payload.taskId) return;
        const entry = deps.delegationManager.get(payload.taskId);
        if (!entry) return;
        deps.delegationManager.reportUncertainty(payload.taskId, payload.reason);
        // P1-1: 流式契约补全 — uncertainty 也通过 EventBus 推送
        getEventBus().emit('stream.uncertainty', {
          taskId: payload.taskId,
          sessionId: entry.sessionId,
          reason: payload.reason,
          correlationId: entry.correlationId,
        });
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

    // 对话内联（doc 22）：本轮 BlockCollector 的 dispose + buildBlocks + persistAssistantTurn 已统一
    // 下沉到 SessionManager.persistInlineBlocks()（由 complete() 调用）。agent.task.result 之后最终态
    // 必经 complete()，blocks 在那里落 message_blocks，此处不再单独落库（避免双重 dispose）。

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
