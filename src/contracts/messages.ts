import type { Socket } from 'node:net';
import type { WritableChannel } from './transport.js';
import type { AgentName, TaskType } from './agents.js';
import type { RouteRequestPayload, RouteDecision, PermissionJudgeResultPayload, AgentUserReplyPayload, AgentAskUserPayload } from './routing.js';
import type { ReviewResult, TurnRecord } from './review.js';
import type { PermissionRequestPayload, PermissionResultPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from './permissions.js';
import type { DelegationEntry, TurnOutputPayload, TurnFinalPayload, TurnCheckpointPayload, TurnCorrectionPayload } from './delegation.js';
import type { UserMessagePayload, DraftResponsePayload, FinalResponsePayload } from './messaging.js';
import type { NormalizedExternalEvent } from './daemon-events.js';
import type { RuntimeInfo } from './daemon-protocol.js';
import type { SocketProgressEvent, SocketInterruptedEvent, SocketResultEvent } from './socket-protocol.js';

// === Socket API Messages (external client → kernel) ===

export interface SocketMessageMap {
  'socket:status': { request: Record<string, unknown>; response: { status: unknown; daemon: unknown } };
  'socket:health': { request: Record<string, unknown>; response: { ok: boolean; uptimeMs: number; agents: unknown; evolutionFailures: number; metrics: unknown } };
  'socket:logs.level.get': { request: Record<string, unknown>; response: { level: string; source: string } };
  'socket:logs.level.set': { request: { level: string; ttl?: string }; response: { ok: boolean; level?: string; previous?: string; error?: string } };
  'socket:permissions.list': { request: { sessionId?: string }; response: { ok: boolean; pending: unknown[] } };
  'socket:permissions.approve': { request: { requestId: string; reason?: string; allowSession?: boolean }; response: { ok: boolean; tokenId?: string | null } };
  'socket:permissions.deny': { request: { requestId: string; reason?: string }; response: { ok: boolean; tokenId?: string | null } };
  'socket:permissions.cancel': { request: { requestId: string }; response: { ok: boolean } };
  'socket:model.override': { request: { sessionId?: string; tier: string }; response: { ok: boolean; sessionId?: string; tier?: string; error?: string } };
  'socket:model.get': { request: { sessionId?: string }; response: { ok: boolean; sessionId: string; currentTier: string; models: Record<string, string> } };
  'socket:evolution.dispatch': { request: { sessionId?: string; taskType: string; requester?: string; inputPayload?: Record<string, unknown> }; response: { ok: boolean; taskId?: string; targetAgent?: string; error?: string } };
  'socket:agents.list': { request: { source?: string; status?: string }; response: { ok: boolean; agents: unknown[] } };
  'socket:agents.inspect': { request: { name: string }; response: { ok: boolean; agent?: unknown; error?: string } };
  'socket:agents.install': { request: { dir: string }; response: { ok: boolean; error?: string } };
  'socket:agents.remove': { request: { name: string; force?: boolean }; response: { ok: boolean; name?: string; error?: string } };
  'socket:agents.upgrade': { request: { name: string }; response: { ok: boolean; name?: string; error?: string } };
  'socket:agents.enable': { request: { name: string }; response: { ok: boolean; name?: string; error?: string } };
  'socket:agents.disable': { request: { name: string; reason?: string }; response: { ok: boolean; name?: string; error?: string } };
  'socket:agents.reload': { request: Record<string, unknown>; response: { ok: boolean; error?: string } };
  'socket:scheduler.jobs.list': { request: { workspaceId?: string }; response: { ok: boolean; jobs: unknown[] } };
  'socket:scheduler.jobs.create': { request: { workspaceId: string; agentId: string; name: string; scheduleType: string; prompt: string; cronExpression?: string; intervalMinutes?: number; webhookSecret?: string; eventFilter?: Record<string, unknown>; concurrencyPolicy?: string; executionMode?: string; sessionMode?: string; maxRetries?: number }; response: { ok: boolean; jobId?: string; webhookToken?: string; error?: string } };
  'socket:scheduler.jobs.get': { request: { jobId: string }; response: { ok: boolean; job?: unknown; error?: string } };
  'socket:scheduler.jobs.delete': { request: { jobId: string }; response: { ok: boolean; error?: string } };
  'socket:scheduler.jobs.trigger': { request: { jobId: string }; response: { ok: boolean; executionId?: string; error?: string } };
  'socket:scheduler.jobs.pause': { request: { jobId: string; reason?: string }; response: { ok: boolean } };
  'socket:scheduler.jobs.resume': { request: { jobId: string }; response: { ok: boolean } };
  'socket:scheduler.queue.status': { request: { workspaceId?: string }; response: { ok: boolean; status?: unknown } };
  'socket:scheduler.chain.approve': { request: { roundId: string; stepId: string }; response: { ok: boolean } };
  'socket:scheduler.chain.reject': { request: { roundId: string; stepId: string; reason: string }; response: { ok: boolean } };
  'socket:scheduler.executions': { request: { jobId: string; limit?: number }; response: { ok: boolean; executions: unknown[] } };
  'socket:message': { request: { message: string; sessionId?: string; streaming?: boolean; permissionMode?: string }; response: SocketResultEvent | SocketInterruptedEvent };
  'socket:interrupt': { request: { sessionId: string; reason?: string }; response: SocketInterruptedEvent };
  'socket:daemon.register': { request: { daemonId: string; pid: number; runtimes: RuntimeInfo[]; maxSlots: number; availableSlots: number }; response: void };
  'socket:daemon.heartbeat': { request: { daemonId: string; availableSlots: number; runningTasks: unknown[] }; response: void };
  'socket:daemon.task.claim': { request: { taskId: string; runtime: string; executionId: string }; response: void };
  'socket:daemon.task.started': { request: { taskId: string; executionId: string; runtime: string; pid: number }; response: void };
  'socket:daemon.task.progress': { request: { taskId: string; executionId: string; event: NormalizedExternalEvent }; response: void };
  'socket:daemon.task.result': { request: { taskId: string; executionId?: string; runtime: string; ok: boolean; output?: string; error?: string; sessionId?: string; usage?: unknown; durationMs?: number; toolCallCount?: number }; response: void };
  'socket:daemon.disconnect': { request: { daemonId: string; reason?: string }; response: void };
}

// === IPC Messages (agent ↔ kernel) ===

export interface IpcMessageMap {
  'ipc:agent.register': { request: { name: string; pid: number }; response: void };
  'ipc:agent.heartbeat': { request: { name: string; uptime: number }; response: void };
  'ipc:user.message': { request: UserMessagePayload; response: void };
  'ipc:draft.response': { request: DraftResponsePayload; response: void };
  'ipc:review.request': { request: TurnRecord; response: void };
  'ipc:review.result': { request: ReviewResult; response: void };
  'ipc:final.response': { request: FinalResponsePayload; response: void };
  'ipc:agent.shutdown': { request: { name: string }; response: void };
  'ipc:permission.request': { request: PermissionRequestPayload; response: void };
  'ipc:permission.result': { request: PermissionResultPayload; response: void };
  'ipc:permission.validate': { request: PermissionValidatePayload; response: void };
  'ipc:permission.consume': { request: PermissionConsumePayload; response: void };
  'ipc:permission.acquire': { request: PermissionAcquirePayload; response: void };
  'ipc:permission.judge': { request: { sessionId: string; agentName: string; toolName: string; toolInput: string; dangerLevel: string; taskContext?: string }; response: void };
  'ipc:permission.judge.result': { request: PermissionJudgeResultPayload; response: void };
  'ipc:tool.audit': { request: { toolName: string; input: string; output: string; durationMs: number; isError: boolean; taskId?: string }; response: void };
  'ipc:memory.query': { request: { query: string; limit?: number }; response: void };
  'ipc:memory.add': { request: { content: string; metadata?: Record<string, unknown> }; response: void };
  'ipc:memory.delete': { request: { id: string }; response: void };
  'ipc:capability.request': { request: { capability: string; args?: unknown }; response: void };
  'ipc:capability.response': { request: { capability: string; result: unknown }; response: void };
  'ipc:task.acknowledge': { request: { taskId: string }; response: void };
  'ipc:agent.task': { request: { taskId: string; taskType: string; inputPayload: Record<string, unknown> }; response: void };
  'ipc:agent.task.result': { request: TurnFinalPayload; response: void };
  'ipc:task.started': { request: { taskId: string }; response: void };
  'ipc:task.progress': { request: TurnOutputPayload; response: void };
  'ipc:route.request': { request: RouteRequestPayload; response: void };
  'ipc:route.result': { request: RouteDecision; response: void };
  'ipc:agent.ask_user': { request: AgentAskUserPayload; response: void };
  'ipc:agent.user_reply': { request: AgentUserReplyPayload; response: void };
  'ipc:model.takeover.request': { request: { sessionId: string; taskId: string }; response: void };
  'ipc:model.takeover.respond': { request: { taskId: string; response: unknown }; response: void };
  'ipc:model.override': { request: { sessionId: string; tier: string }; response: void };
  'ipc:plugins.register_tools': { request: { tools: unknown[] }; response: void };
  'ipc:plugin.execute': { request: { pluginId: string; method: string; args: unknown }; response: void };
  'ipc:plugin.execute.result': { request: { pluginId: string; result: unknown; error?: string }; response: void };
  'ipc:skill.changed': { request: { skillId: string; action: string }; response: void };
  'ipc:task.cancel': { request: { taskId: string; reason?: string }; response: void };
  'ipc:task.telemetry': { request: TurnOutputPayload; response: void };
  'ipc:checkpoint.evaluate': { request: TurnCheckpointPayload; response: void };
  'ipc:checkpoint.evaluate.result': { request: { delegationId: string; action: string; instruction?: string; constraints?: unknown }; response: void };
  'ipc:turn.correction': { request: TurnCorrectionPayload; response: void };
}

// === Event Messages (broadcast, pub/sub) — single source of truth for event types ===

export type EventMap = {
  'task.created': { taskId: string; taskType: TaskType; targetAgent: AgentName };
  'task.dispatched': { taskId: string; targetAgent: AgentName };
  'task.acknowledged': { taskId: string; targetAgent: AgentName };
  'task.started': { taskId: string; targetAgent: AgentName };
  'task.progress': { taskId: string; message: string; payload?: Record<string, unknown> };
  'task.completed': { taskId: string; targetAgent: AgentName; outputPayload: Record<string, unknown> };
  'task.failed': { taskId: string; targetAgent: AgentName; error: string };
  'task.timeout': { taskId: string; targetAgent: AgentName };
  'task.cancelled': { taskId: string; reason?: string };
  'task.notification': { taskId: string; notification: Record<string, unknown> };
  'task.backgrounded': { taskId: string };
  'task.retrieved': { taskId: string };
  'task.resumed': { taskId: string; strategy?: string };
  'task.resumable': { taskId: string; errorType: string; error: string };
  'task.resume.restart': { taskId: string };
  'checkpoint.saved': { taskId: string; stepIndex: number };
  'task.force_updated': { taskId: string; status: string; reason: string };
  'agent.registered': { name: AgentName; pid: number };
  'agent.crashed': { name: AgentName; error?: string; circuitBroken?: boolean };
  'agent.installed': { name: AgentName; source: string; version: string };
  'agent.removed': { name: AgentName; reason?: string };
  'agent.upgraded': { name: AgentName; fromVersion: string; toVersion: string };
  'agent.enabled': { name: AgentName };
  'agent.disabled': { name: AgentName; reason?: string };
  'review.requested': { reviewId: string; level: string; sessionId: string };
  'review.completed': { reviewId: string; verdict: string };
  'budget.alert': { scope: string; scopeId: string; tier: string; usedPercent: number; message: string };
  'workspace.created': { workspaceId: string; slug: string };
  'workspace.updated': { workspaceId: string };
  'workspace.file_changed': { workspaceId: string; path: string; changeType: string };
  'config.reloaded': { fields: string[] };
  'cron.fired': { taskId: string; description: string };
  'cron.completed': { taskId: string; output: string };
  'cron.failed': { taskId: string; error: string; attempt: number };
  'mcp.connected': { serverName: string; toolCount: number; capabilities: string[] };
  'mcp.disconnected': { serverName: string; reason?: string };
  'mcp.failed': { serverName: string; error: string; circuitBroken?: boolean };
  'mcp.tools_changed': { serverName: string; added: string[]; removed: string[] };
  'mcp.reconnecting': { serverName: string; attempt: number; delayMs: number };
  'mcp.auth_required': { serverName: string; authUrl?: string };
  'mcp.sampling_request': { serverName: string; model?: string };
  'daemon.connected': { daemonId: string; runtimes: RuntimeInfo[] };
  'daemon.disconnected': { daemonId: string; reason: string };
  'daemon.task.progress': { taskId: string; event: NormalizedExternalEvent };
  'daemon.task.completed': { taskId: string; runtime: string; durationMs: number };
  'daemon.task.failed': { taskId: string; runtime: string; error: string };
  'delegation.created': { delegationId: string; sessionId: string; targetAgent: string };
  'delegation.acknowledged': { delegationId: string; targetAgent: string };
  'delegation.completed': { delegationId: string; targetAgent: string; durationMs: number };
  'delegation.failed': { delegationId: string; targetAgent: string; error: string };
  'delegation.checkpoint_needed': { delegationId: string; trigger: string };
  'message.received': { sessionId: string; message: string; taskId: string };
  'message.routed': { sessionId: string; taskId: string; targetAgent: string; intent?: string };
  'message.responded': { sessionId: string; taskId: string; response: string; verdict?: string };
  'tool.executed': { agentName: string; toolName: string; durationMs: number; isError: boolean; taskId?: string };
  'llm.request.completed': { taskId?: string; agentName: string; inputTokens: number; outputTokens: number; cacheRead?: number; cacheCreation?: number; durationMs: number };
  'scheduler.job_enqueued': { jobId: string; queueItemId: string; triggerSource: string };
  'scheduler.job_claimed': { queueItemId: string; agentId: string };
  'scheduler.job_completed': { queueItemId: string; jobId: string; durationMs: number };
  'scheduler.job_failed': { queueItemId: string; jobId: string; error: string; retryable: boolean };
  'scheduler.webhook_received': { jobId: string; requestId: string; verified: boolean };
  'scheduler.chain_started': { roundId: string; jobId: string; totalSteps: number };
  'scheduler.chain_step_completed': { roundId: string; stepId: string };
  'scheduler.chain_approval_pending': { roundId: string; stepId: string };
  'scheduler.chain_completed': { roundId: string };
  'scheduler.auto_paused': { jobId: string; failureRate: number; totalExecutions: number };
  'scheduler.reminder_fired': { reminderId: string; agentId: string };
  // P7: Intelligence layer events
  'notification.created': { notificationId: string; workspaceId: string; targetType: string; targetId: string; type: string };
  'notification.read': { notificationId: string };
  'memory.agent.created': { memoryId: string; agentId: string };
  'memory.agent.promoted': { memoryId: string; targetLayer: 'workspace' | 'global' };
  'memory.workspace.created': { memoryId: string; workspaceId: string };
  'memory.global.created': { memoryId: string; userId: string };
  'memory.decayed': { memoryId: string; layer: string; newImportance: number };
  'workspace.context_updated': { workspaceId: string; version: number };
  'delegation.async.created': { delegationId: string; targetWorkspaceId: string };
  'delegation.async.accepted': { delegationId: string };
  'delegation.async.completed': { delegationId: string; success: boolean };
  'delegation.async.timeout': { delegationId: string };
  'template.created': { templateId: string };
  'template.used': { templateId: string; workspaceId: string };
  'plugin.scope_changed': { pluginId: string; oldScope: string; newScope: string };
  'permission.user_confirm_needed': { requestId: string; sessionId: string; agentName: string; toolName: string; toolInput: string; dangerLevel: string; brainReason: string };
  'delegation.user_needed': { delegationId: string; sessionId: string; requestedBy: string; title: string; description: string; urgency: string; options: string[] };
  // Stream / dialogue transport 事件（H2 kernel EventBus 化）
  // kernel 业务层 emit 出去，由 WsEventBridge（src/web/）订阅 EventBus 并转发到 WS 客户端
  // 不再让 kernel 业务路径直接持 user-side ws.Socket
  'stream.text_delta': { taskId: string; sessionId: string; text: string; correlationId?: string };
  'stream.reasoning_delta': { taskId: string; sessionId: string; text: string; correlationId?: string };
  'stream.tool_call': { taskId: string; sessionId: string; toolName: string; input: unknown; result?: unknown; isError?: boolean; durationMs?: number; correlationId?: string };
  'stream.tool_result': { taskId: string; sessionId: string; toolName: string; result?: unknown; isError?: boolean; durationMs?: number; correlationId?: string };
  'stream.uncertainty': { taskId: string; sessionId: string; reason: string; correlationId?: string };
  'dialogue.status': { dialogueId: string; sessionId: string; status: 'started' | 'round_complete' | 'ended'; from: string; to: string; round: number };

  // delegation-orchestrator 内部 emit 的事件（多端共享流式会话状态）
  'conversation.handoff': { sessionId: string; from: string; to: string; intent?: string; correlationId?: string };
  'conversation.ask_user': { sessionId: string; taskId?: string; agent: string; question: string; options?: unknown[]; correlationId?: string };
  'conversation.progress': { sessionId: string; taskId?: string; status: string; summary: string };
  'conversation.no_response': { sessionId: string; reason: string; taskId?: string; clientMsgId?: string; correlationId?: string };
  /** P0-3: 对话被中断 — 通过 EventBus 投递，WsEventBridge 转发到前端 */
  'conversation.interrupted': { sessionId: string; taskId: string | null; reason: string };
  /** P1-5: 对话最终结果 — WS 路径通过 EventBus 投递，不再 resolve 直写 channel */
  'conversation.result': { sessionId: string; taskId: string; response: string };
};

export type EventMessageMap = {
  [K in keyof EventMap as `event:${K & string}`]: { request: EventMap[K]; response: void };
};

// === Unified MessageMap ===

export type MessageMap = SocketMessageMap & IpcMessageMap & EventMessageMap;
export type MessageType = keyof MessageMap;
export type SocketMessageType = keyof SocketMessageMap;
export type IpcBusMessageType = keyof IpcMessageMap;
export type EventMessageType = keyof EventMessageMap;

export type MessagePayload<T extends MessageType> = MessageMap[T]['request'];
export type MessageResult<T extends MessageType> = MessageMap[T]['response'];

export type MessageHandler<T extends MessageType> = (
  payload: MessagePayload<T>,
  ctx: MessageContext,
) => MessageResult<T> | Promise<MessageResult<T>>;

export type MessageListener<T extends MessageType> = (
  payload: MessagePayload<T>,
) => void;

export interface MessageContext {
  /** 原始 Socket（仅 daemon IPC 等需要 raw socket 的场景使用） */
  socket?: Socket;
  /** 传输层写入通道（socket-server/harness 路径通过此字段回写响应） */
  channel?: WritableChannel;
  correlationId?: string;
  from?: string;
  traceId?: string;
  connectionId?: string;
  sequenceNum?: number;
  ack?: () => void;
}
