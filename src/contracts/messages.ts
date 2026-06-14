import type { Socket } from 'node:net';
import type { WritableChannel } from './transport.js';
import type { AgentName, TaskType } from './agents.js';
import type { RouteRequestPayload, RouteDecision, PermissionJudgeResultPayload, AgentUserReplyPayload, AgentAskUserPayload } from './routing.js';
import type { ReviewResult, ReviewVerdict, TurnRecord } from './review.js';
import type { PermissionRequestPayload, PermissionResultPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from './permissions.js';
import type { DelegationEntry, TurnOutputPayload, TurnFinalPayload, TurnCheckpointPayload, TurnCorrectionPayload } from './delegation.js';
import type { UserMessagePayload, DraftResponsePayload, FinalResponsePayload } from './messaging.js';
import type { NormalizedExternalEvent } from './daemon-events.js';
import type { RuntimeInfo } from './daemon-protocol.js';
import type { SocketProgressEvent, SocketInterruptedEvent, SocketResultEvent } from './socket-protocol.js';
import type { StreamBlockPayload } from './message-blocks.js';

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
  /** 13.0 §8.6: Brain 自我审核反馈 — 用户/Evolution 反馈 Brain 修改后的 lesson 写入 */
  'ipc:brain.review.feedback': {
    request: {
      decisionId: string;
      /** 反馈类型：'user_explicit' | 'evolution_derived' | 'auto_evolution' */
      feedbackType: 'user_explicit' | 'evolution_derived' | 'auto_evolution';
      lesson: string;
      /** 可选：outcome（good/bad/neutral） */
      outcome?: 'good' | 'bad' | 'neutral';
    };
    response: { ok: boolean; id?: string; reason?: string };
  };
  /** 13.0 §5.3.7: Agent 或 Evolution Engine 写用户偏好（跨 session 持久化） */
  'ipc:user.remember_preference': {
    request: {
      userId?: string;
      prefKey: string;
      prefValue: string;
      source?: 'evolution_engine' | 'brain_decision' | 'user_explicit' | 'restore_original';
      confidence?: number;
      expiresAt?: number | null;
    };
    response: { ok: boolean; id?: string; reason?: string };
  };
  /** 13.0 §5.3.7: 读用户偏好 */
  'ipc:user.get_preferences': {
    request: { userId?: string; keyPrefix?: string };
    response: { ok: boolean; preferences?: Array<{ key: string; value: string; source: string; confidence: number }>; reason?: string };
  };
  // 13.0 §13.8/§11.4/§11.7: Brain 子进程 ↔ core 跨进程事件中继
  //（EventBus 是进程内的，brain 作为独立子进程发不到 core，故改走 IPC 边界）
  'ipc:cron.review': {
    request: { taskId: string; description: string; output: string; createdAt: number };
    response: void;
  };
  'ipc:brain.signal_intervention': {
    request: { missionId: string; from: string; signalType: string; signalMsg: string; instruction: string; severity: 'low' | 'medium' | 'high'; createdAt: number };
    response: void;
  };
  'ipc:brain.checker.dispatch': {
    request: { missionId: string; planTaskId: string; sessionId: string; checkerAgent: string; checkerOn: string; checkerCorrelationId: string; parentCorrelationId: string; workerOutput: string; workerTask: string; brainVerdict: string; brainReason: string };
    response: void;
  };
  'ipc:brain.cron_review_flagged': {
    request: { taskId: string; verdict: string; reason: string; correctedOutput?: string };
    response: void;
  };
}

// === Event Messages (broadcast, pub/sub) — single source of truth for event types ===

export type EventMap = {
  'task.created': { taskId: string; taskType: TaskType; targetAgent: AgentName };
  'task.dispatched': { taskId: string; targetAgent: AgentName };
  'task.acknowledged': { taskId: string; targetAgent: AgentName };
  'task.started': { taskId: string; targetAgent: AgentName };
  'task.progress': { taskId: string; message: string; payload?: Record<string, unknown> };
  /** 13.0 §13.10: 任务进度心跳 — 长时间无 tool_call 时的存活信号 */
  'task.heartbeat': { taskId: string; agentName: string; elapsedMs: number; lastActivity: string; timestamp: number };
  'task.completed': { taskId: string; targetAgent: AgentName; outputPayload: Record<string, unknown> };
  'task.failed': { taskId: string; targetAgent: AgentName; error: string };
  /** §13.16: 任务超时自动终止（TaskHeartbeatManager 检测到 maxTaskDuration 超限） */
  'task.timeout': { taskId: string; targetAgent: AgentName; delegationId?: string; elapsedMs?: number; reason?: string };
  'task.cancelled': { taskId: string; reason?: string };
  'task.notification': { taskId: string; notification: Record<string, unknown> };
  'task.backgrounded': { taskId: string };
  'task.retrieved': { taskId: string };
  'task.resumed': { taskId: string; strategy?: string };
  'task.resumable': { taskId: string; errorType: string; error: string };
  'task.resume.restart': { taskId: string };
  /** 13.0 §8.7 + §5.3.14: Agent 拒绝任务时发 task.reject（Brain observe 触发纠偏或降级为 askUser） */
  'task.reject': {
    taskId: string;
    agentName: string;
    reason: string;
    /** Agent 自报的 capability gap（Brain 可基于此重路由） */
    capabilityGap?: string;
    timestamp: number;
  };
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
  /** 13.0 §13.9: Cron 任务结果通过 cron.review 事件携带 description 作为 Brain 审核基准 */
  'cron.review': {
    taskId: string;
    description: string;
    output: string;
    /** 触发 review 的时间戳（Brain 可用此判断延迟） */
    createdAt: number;
  };
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
  'delegation.created': { delegationId: string; sessionId: string; targetAgent: string; queuePosition?: number; expectedWaitMs?: number };
  'delegation.acknowledged': { delegationId: string; targetAgent: string };
  'delegation.completed': { delegationId: string; targetAgent: string; durationMs: number };
  'delegation.failed': { delegationId: string; targetAgent: string; error: string };
  'delegation.checkpoint_needed': { delegationId: string; trigger: string };
  'message.received': { sessionId: string; message: string; taskId: string };
  'message.routed': { sessionId: string; taskId: string; targetAgent: string; intent?: string };
  'message.responded': { sessionId: string; taskId: string; response: string; /** Brain 审核裁决（approve/modify/reject），或 'restored'（用户还原了 Brain 的修改） */ verdict?: string; /** 13.0 灵魂版：Brain 审核理由（modify/reject 时非空） */ reviewReason?: string; /** 13.0 灵魂版：Brain 修改前的原始初稿 */ originalDraft?: string };
  'tool.executed': { agentName: string; toolName: string; durationMs: number; isError: boolean; taskId?: string };
  'llm.request.completed': { taskId?: string; agentName: string; inputTokens: number; outputTokens: number; cacheRead?: number; cacheCreation?: number; durationMs: number };
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
  /**
   * 对话内联统一事件族（见 设计文档/22-对话内联统一.md）。
   * 收敛 stream.text_delta / stream.tool_call / stream.tool_result / stream.reasoning_delta / agent.dialogue
   * 到单一事件：文本/工具/MCP/委派都是 Block，前端按 blockId 幂等推进、按 blockType 内联渲染。
   * 旧事件保留兼容期（仍可 emit），新链路以 stream.block 为准。
   */
  'stream.block': StreamBlockPayload;
  'dialogue.status': { dialogueId: string; sessionId: string; status: 'started' | 'round_complete' | 'ended'; from: string; to: string; round: number };
  /** 13.0 灵魂版：Agent 间对话每条消息推送至前端对话面板 */
  'agent.dialogue': { dialogueId: string; sessionId?: string; taskId?: string; from: string; to: string; content: string; round: number; phase: 'send' | 'reply' | 'end'; timestamp: number };

  // delegation-orchestrator 内部 emit 的事件（多端共享流式会话状态）
  'conversation.handoff': { sessionId: string; from: string; to: string; intent?: string; correlationId?: string };
  'conversation.ask_user': { sessionId: string; taskId?: string; agent: string; question: string; options?: unknown[]; correlationId?: string };
  'conversation.progress': { sessionId: string; taskId?: string; status: string; summary: string };
  'conversation.no_response': { sessionId: string; reason: string; taskId?: string; clientMsgId?: string; correlationId?: string };
  /** P0-3: 对话被中断 — 通过 EventBus 投递，WsEventBridge 转发到前端 */
  'conversation.interrupted': { sessionId: string; taskId: string | null; reason: string };
  /** P1-5: 对话最终结果 — WS 路径通过 EventBus 投递，不再 resolve 直写 channel
   *  13.0 灵魂版：携带 Brain 审核信息，前端可展示"已审核/已修改"徽章 */
  'conversation.result': { sessionId: string; taskId: string; response: string; reviewVerdict?: ReviewVerdict; reviewReason?: string; originalDraft?: string };

  // ─── 13.0 多智能体协作 — Mission 事件 ───
  /** 13.0: Mission 被创建 */
  'mission.created': { missionId: string; goal: string; taskCount: number };
  /** 13.0: Mission 状态变更 */
  'mission.status_changed': { missionId: string; oldStatus: string; newStatus: string };
  /** 13.0: 任务状态变更 */
  'mission.task_updated': { missionId: string; taskId: string; status: import('./mission.js').TaskStatus; who: string };
  /** 13.0: 任务依赖满足，可以开始执行 */
  'mission.task_ready': { missionId: string; taskId: string; who: string; what: string };
  /** 13.0: Mission 完成（所有 tasks done） */
  'mission.completed': { missionId: string; goal: string };
  /** 13.0: Squad 被创建（裂变） */
  'mission.squad_created': { missionId: string; squadId: string; parentSquadId?: string };
  /** 13.0: 信号发出 */
  'mission.signal': { missionId: string; squadId: string; type: import('./mission.js').SignalType; msg: string };
  /** 13.0: 交接完成 */
  'mission.handoff': { missionId: string; from: string; to: string; what: string };
  /** 13.0 P9: Brain 观察 blocker/question signal 后触发的 INTERVENE 事件 */
  'brain.signal_intervention': {
    missionId: string;
    from: string;
    signalType: string;
    signalMsg: string;
    instruction: string;
    severity: 'low' | 'medium' | 'high';
    createdAt: number;
  };
  /** 13.0 §5.3.10: Agent 目录变更推送 */
  'directory.changed': { added: Array<{ name: string; description: string; capabilities: string[]; status: 'online' | 'offline' }>; removed: string[] };
  /** 13.0 §5.1.3: Brain 发出纠偏（前端订阅后可显示纠偏原因/历史） */
  'brain.correction': {
    sessionId: string;
    taskId?: string;
    agentName: string;
    action: 'continue' | 'adjust' | 'stop' | 'restart';
    severity: 'low' | 'medium' | 'high';
    instruction?: string;
    newConstraints?: { forbiddenTools?: string[]; maxRemainingTokens?: number; requiredApproach?: string };
    createdAt: number;
  };
  /** 13.0 §4.4.2: 跨 agent 预算告警（per-agent token 实时推送） */
  'brain.budget.alert': {
    sessionId?: string;
    agentName: string;
    scope: string;
    usedPercent: number;
    tier: 'warning' | 'critical' | 'exceeded';
    message: string;
    createdAt: number;
  };
  /** 13.0 P10: Brain 派发 checker 独立审核事件（kernel 订阅后路由给 checker agent） */
  'brain.checker.dispatch': {
    missionId: string;
    planTaskId: string;
    sessionId: string;
    checkerAgent: string;
    checkerOn: string;
    checkerCorrelationId: string;
    parentCorrelationId: string;
    workerOutput: string;
    workerTask: string;
    brainVerdict: string;
    brainReason: string;
  };
  /** 13.0 §5.3.4: 用户点击「反馈 Brain 修改有问题」时 mission-api 路由发的事件 */
  'brain.feedback': {
    sessionId: string;
    taskId: string;
    feedbackType: string;
    userComment?: string;
    originalResponse?: string;
    modifiedResponse?: string;
  };
  /** 13.0 §13.8: cron 任务 LLM 审核发现问题（verdict 非 approve）时广播 */
  'brain.cron_review_flagged': {
    taskId: string;
    verdict: 'modify' | 'reject';
    reason: string;
    correctedOutput?: string;
  };
  /** 13.0 §13.5: 用户级 session 队列通知（前端显示「等待中」提示） */
  'user.session.queued': {
    userId: string;
    correlationId: string;
    position: number;
    enqueuedAt: number;
  };
  /** 13.0 §13.5: 用户级 session 出队通知 */
  'user.session.dequeued': {
    userId: string;
    correlationId: string;
    waitedMs: number;
  };
  /** 13.0 §13.5: 用户回复 ask_user（agent 等的真实用户回复） */
  'user.ask_response': {
    sessionId: string;
    taskId?: string;
    correlationId: string;
    response: string;
  };
  /** 13.0 §13.20: Evolution Engine 触发（频率/反馈/learning 三类 source） */
  'capability.evolution.request': {
    agentName: string;
    sessionId: string;
    taskId: string;
    reason: string;
    windowStats?: { highCount: number; totalCount: number; windowMs: number };
    samples?: Array<{ severity: string; action: string; instruction: string }>;
    source?: string;
    feedbackType?: string;
    userComment?: string;
    originalResponseSnippet?: string;
    modifiedResponseSnippet?: string;
    /** 13.0 P5: 触发技能创建时附带的 mission ID */
    missionId?: string;
    /** §5.3.4: 触发时间戳 */
    createdAt?: number;
    /** 13.0 P5: 技能描述（who:"skills" 的 task 完成后的 result） */
    skillDescription?: string;
  };
  /** 13.0 §13.18: v2 插件工具注册到全局 ToolRegistry 后广播变更 */
  'tools.updated': { added: string[] };
  /**
   * 16.0 P5-C2：任务板有新信封落板（WsEventBridge 订阅后转发 ws.type='board.message' 给前端）。
   *
   * 设计意图：board 写入是 DB 操作（task_thread 表 INSERT），不是 EventBus 事件。
   * board-projection.safePost 在落板成功后 emit 此事件，让前端经 WsEventBridge 实时感知
   * 「这块板有新发言了」——用于前端看板 UI 刷新（设计文档/23 §9 P5「旧通道降兼容层」）。
   *
   * 字段语义：
   *   - taskId：板 id（= delegationId，板与 delegation 1:1）
   *   - sessionId：关联会话 id（WsEventBridge 按此过滤推送给订阅了该 session 的前端客户端）
   *   - messageType：信封类型（delegate/report/ask/tool_request/tool_result/command/tell）
   *     前端可据此决定 UI 优先级（如 command 高亮、report 更新状态徽章）
   *   - messageId：板上信封 id（前端可据此去重 / 定位）
   *   - from / to：信封收发方（前端看板气泡渲染用）
   */
  'board.message.posted': {
    taskId: string;
    sessionId?: string;
    messageType: 'delegate' | 'report' | 'ask' | 'tool_request' | 'tool_result' | 'command' | 'tell';
    messageId?: string;
    from?: string;
    to?: string;
  };
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
