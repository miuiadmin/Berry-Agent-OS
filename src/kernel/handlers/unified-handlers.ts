import type { MessageBus } from '../message-bus.js';
import type { ServiceContainer } from '../service-container.js';
import type { SocketMessageType, MessageContext, MessageType } from '../../contracts/messages.js';
import type { WritableChannel } from '../../contracts/transport.js';
import type {
  DaemonRegisterMessage,
  DaemonHeartbeatMessage,
  DaemonTaskClaimMessage,
  DaemonTaskStartedMessage,
  DaemonTaskProgressMessage,
  DaemonTaskResultMessage,
  DaemonDisconnectMessage,
} from '../../contracts/daemon-protocol.js';
import type { SocketResultEvent, SocketInterruptedEvent } from '../../contracts/socket-protocol.js';
import type { RouteRequestPayload } from '../../contracts/routing.js';
import type { ModelTier } from '../../contracts/model.js';
import type { LogLevel } from '../../observability/types.js';
import { PermissionEngine } from '../../safety/permissions.js';
import { TokenIssuer } from '../../safety/token-issuer.js';
import { ApprovalManager } from '../../safety/approval-manager.js';
import { buildAvailableAgentsList } from '../agent-registry.js';
import { createTaskWorkspace } from '../task-workspace.js';
import { getAgentHomePath } from '../agent-home.js';
import { getUserAgentsDir } from '../../utils/paths.js';
import { getDb } from '../../memory/index.js';
import { genId } from '../../utils/id.js';
import { getEventBus } from '../event-bus.js';
import { metrics } from '../../observability/metrics.js';
import { getLogger } from '../../utils/logger.js';
import { join } from 'node:path';

const logger = getLogger('unified-handlers');

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type HandlerFn = (request: Record<string, unknown>, ctx: MessageContext, services: ServiceContainer) => void | Promise<void>;

interface HandlerDefinition {
  type: string;
  handler: HandlerFn;
}

// --- Input validation helpers ---

function requireString(request: Record<string, unknown>, field: string): string | undefined {
  const val = request[field];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function requireFields(ctx: MessageContext, request: Record<string, unknown>, fields: string[]): string[] | null {
  const values: string[] = [];
  for (const f of fields) {
    const v = requireString(request, f);
    if (!v) {
      ctx.channel!.write(JSON.stringify({ ok: false, error: `缺少 ${f} 参数` }) + '\n');
      return null;
    }
    values.push(v);
  }
  return values;
}

function reply(ctx: MessageContext, data: Record<string, unknown>): void {
  ctx.channel!.write(JSON.stringify(data) + '\n');
}

function replyError(ctx: MessageContext, error: string): void {
  ctx.channel!.write(JSON.stringify({ ok: false, error }) + '\n');
}

// === Observability Handlers ===

const statusHandler: HandlerFn = (_, ctx, services) => {
  const status = services.agentManager.getStatus();
  const daemon = services.getDaemonStatus?.() ?? null;
  reply(ctx, { status, daemon });
};

const healthHandler: HandlerFn = (_, ctx, services) => {
  const agentStatus = services.agentManager.getStatus();
  const metricsSnapshot = metrics.snapshot();
  const evolutionFailures = services.memoryRuntime.getEvolutionFailures();
  reply(ctx, {
    ok: true,
    uptimeMs: metricsSnapshot.uptimeMs,
    agents: agentStatus,
    evolutionFailures,
    metrics: metricsSnapshot,
  });
};

const getLogLevelHandler: HandlerFn = (_, ctx, services) => {
  reply(ctx, { level: services.getLogLevel(), source: 'runtime' });
};

const setLogLevelHandler: HandlerFn = (request, ctx, services) => {
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const level = requireString(request, 'level') as LogLevel | undefined;
  if (!level || !validLevels.includes(level)) {
    replyError(ctx, '无效的日志等级');
    return;
  }
  const previousLevel = services.getLogLevel();
  services.setLogLevel(level);

  const existingTimer = services.getLogLevelResetTimer();
  if (existingTimer) {
    clearTimeout(existingTimer);
    services.setLogLevelResetTimer(null);
  }

  const ttl = requireString(request, 'ttl');
  if (ttl) {
    const match = ttl.match(/^(\d+)(s|m|h)$/);
    if (match) {
      const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
      const ms = parseInt(match[1], 10) * multipliers[match[2]];
      services.setLogLevelResetTimer(setTimeout(() => {
        services.setLogLevel(services.config.observability.level as LogLevel);
        logger.info({ level: services.getLogLevel() }, '日志等级临时设置已到期，已恢复默认等级');
      }, ms));
    }
  }

  logger.info({ from: previousLevel, to: services.getLogLevel(), ttl }, '日志等级已变更');
  reply(ctx, { ok: true, level: services.getLogLevel(), previous: previousLevel });
};

// === Permission Handlers ===

const listPermissionsHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = requireString(request, 'sessionId');
  const pending = services.permissionCoordinator.getPending(sessionId) ?? [];
  reply(ctx, { ok: true, pending });
};

const resolvePermissionHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['requestId']);
  if (!vals) return;
  const [requestId] = vals;
  const type = requireString(request, 'type');

  if (type === 'permissions.cancel') {
    const cancelled = services.permissionCoordinator.cancel(requestId) ?? false;
    reply(ctx, { ok: cancelled });
    return;
  }

  const token = services.permissionCoordinator.resolve(requestId, {
    verdict: type === 'permissions.approve' ? 'approved' : 'denied',
    source: 'user',
    reason: typeof request.reason === 'string' ? request.reason : undefined,
    tokenVerdict: request.allowSession ? 'allow_session' : 'allow_once',
  }) ?? null;
  reply(ctx, { ok: true, tokenId: token?.id ?? null });
};

// === Model Handlers ===

const modelOverrideHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = requireString(request, 'sessionId') ?? '';
  const tier = requireString(request, 'tier');
  if (!tier || !['fast', 'default', 'high'].includes(tier)) {
    replyError(ctx, '无效的模型层级，可选: fast / default / high');
    return;
  }
  services.sessionManager.setModelOverride(sessionId, tier as ModelTier);
  reply(ctx, { ok: true, sessionId, tier });
};

const modelGetHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = requireString(request, 'sessionId') ?? '';
  const tier = services.sessionManager.getModelOverride(sessionId) ?? 'default';
  const models = services.config.llm.models;
  reply(ctx, {
    ok: true,
    sessionId,
    currentTier: tier,
    models: {
      fast: models.fast ?? services.config.llm.model,
      default: models.default ?? services.config.llm.model,
      high: models.high ?? services.config.llm.model,
    },
  });
};

const evolutionDispatchHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['taskType']);
  if (!vals) return;
  const [taskType] = vals;
  services.messageRouter.dispatchModuleTask({
    sessionId: requireString(request, 'sessionId') ?? genId('ses'),
    taskType,
    requester: requireString(request, 'requester') ?? 'cli',
    inputPayload: (request.inputPayload as Record<string, unknown>) ?? {},
  })
    .then((result) => reply(ctx, { ok: true, ...result }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

// === Agent Handlers ===

const agentsListHandler: HandlerFn = (request, ctx, services) => {
  const rows = services.agentLifecycle.list({
    source: requireString(request, 'source'),
    status: requireString(request, 'status'),
  });
  reply(ctx, { ok: true, agents: rows });
};

const agentsInspectHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['name']);
  if (!vals) return;
  const [name] = vals;
  const detail = services.agentLifecycle.inspect(name);
  if (!detail) {
    replyError(ctx, `智能体不存在: ${name}`);
    return;
  }
  reply(ctx, { ok: true, agent: detail });
};

const agentsInstallHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['dir']);
  if (!vals) return;
  const [dir] = vals;
  services.agentLifecycle.install(dir)
    .then((result) => reply(ctx, { ok: true, ...result }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

const agentsRemoveHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['name']);
  if (!vals) return;
  const [name] = vals;
  services.agentLifecycle.remove(name, { force: request.force === true })
    .then(() => reply(ctx, { ok: true, name }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

const agentsUpgradeHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['name']);
  if (!vals) return;
  const [name] = vals;
  services.agentLifecycle.upgrade(name)
    .then((result) => reply(ctx, { ok: true, name, ...result }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

const agentsEnableHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['name']);
  if (!vals) return;
  const [name] = vals;
  services.agentLifecycle.enable(name)
    .then(() => reply(ctx, { ok: true, name }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

const agentsDisableHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['name']);
  if (!vals) return;
  const [name] = vals;
  services.agentLifecycle.disable(name, typeof request.reason === 'string' ? request.reason : undefined)
    .then(() => reply(ctx, { ok: true, name }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

const agentsReloadHandler: HandlerFn = (_, ctx, services) => {
  services.agentLifecycle.reload(getUserAgentsDir())
    .then((result) => reply(ctx, { ok: true, ...result }))
    .catch((err) => replyError(ctx, getErrorMessage(err)));
};

// === Messaging Handlers ===

/**
 * 路由用户消息的私有 helper。
 * R8-1：把 messaging-handlers.ts 的 handleMessage / handleChannelMessage
 * 合并到 unified-handlers.ts，消除两份 85% 同构实现。
 *
 * 统一语义：
 * - 必传 WritableChannel 抽象，传输层（WS / CLI / Channel）解耦
 * - saveUserMessage 入口入库（先入库再 createPending，失败 warn 继续路由 fail-open）
 * - 并发防护 hasActivePendingForSession 两条路径都强制
 * - createTaskWorkspace 显式覆盖（channel 路径不创建，避免 channel-only 副作用）
 * - resolve 仅 emit 'conversation.result' 事件，传输层订阅 EventBus 派发
 */
function routeUserMessage(
  message: string,
  ctx: ServiceContainer | MessageBusHandlerContext,
  services: ServiceContainer,
  options: {
    sessionId: string;
    isStreaming: boolean;
    clientMsgId: string;
    createWorkspace: boolean;
    /** channel 路径下没有 clientId，传 false 跳过 hasActivePendingForSession 检查 */
    skipConcurrentCheck?: boolean;
    /** 入口标记（仅用于日志） */
    entry: 'ws' | 'socket' | 'channel';
    /** channel 路径专用：channel 入口并发错误时回写通道 */
    onChannelBusy?: () => void;
    /**
     * R8-1 fix：resolve 行为 override
     * - 不传（WS 路径）：emit 'conversation.result' 事件，WsEventBridge 订阅后转发
     * - 传 channel（socket-server / harness 路径）：resolve 同步直写 channel.write
     *   保持 R5 行为 — harness 不订阅 EventBus，等 'type: result' 消息必须直写
     */
    channelOverride?: WritableChannel;
  },
): void {
  const { sessionId, isStreaming, clientMsgId, createWorkspace, entry } = options;

  // 入口入库：先 saveUserMessage 再 createPending（user 消息在中断时全丢的双层漏洞的第一道闸门）
  try {
    services.sessionManager.saveUserMessage(sessionId, message, { clientMsgId });
  } catch (err) {
    logger.warn({ err, sessionId, entry }, `${entry} 入口入库 user 消息失败`);
  }

  if (services.sessionManager.hasPendingAsk(sessionId)) {
    services.messageRouter.sendUserReply({
      sessionId,
      taskId: services.sessionManager.getPendingAsk(sessionId)!.taskId,
      reply: message,
    }, genId('reply'));
    if (options.onChannelBusy) options.onChannelBusy();
    return;
  }

  if (!options.skipConcurrentCheck && services.sessionManager.hasActivePendingForSession(sessionId)) {
    if (options.onChannelBusy) {
      options.onChannelBusy();
    } else {
      logger.warn({ sessionId, entry }, '同一对话已有 pending 任务，跳过投递');
    }
    return;
  }

  const msgId = genId('msg');
  const route = services.taskRouter.route({ taskType: 'conversation_turn', requester: 'user' });
  const taskId = services.taskManager.create({
    sessionId,
    correlationId: msgId,
    taskType: 'conversation_turn',
    requester: 'user',
    targetAgent: route.targetAgent,
    foreground: true,
    inputPayload: { message, routeReason: route.reason },
  });

  services.sessionManager.createPending(msgId, {
    sessionId,
    clientId: undefined,
    userMessage: message,
    taskId,
    streaming: isStreaming,
    resolve: (response) => {
      if (options.channelOverride) {
        // R5 行为：socket-server / harness 路径同步直写 channel
        if (isStreaming) {
          const evt: SocketResultEvent = { type: 'result', response, sessionId, taskId };
          options.channelOverride.write(JSON.stringify(evt) + '\n');
          options.channelOverride.end();
        } else {
          options.channelOverride.write(JSON.stringify({ response, sessionId, taskId }) + '\n');
        }
      } else {
        // 解耦形态：emit 'conversation.result' 事件，由 WsEventBridge 订阅后转发 WS 客户端
        getEventBus().emit('conversation.result', { sessionId, taskId, response });
      }
    },
  });

  if (createWorkspace) {
    const primaryName = services.registry.requireRole('primary').manifest.name;
    const agentHome = getAgentHomePath(primaryName);
    try {
      createTaskWorkspace(
        join(agentHome, 'tasks'),
        taskId,
        { sessionId, message, createdAt: Date.now() },
      );
    } catch (err) {
      logger.error({ err, taskId, entry }, '创建任务工作空间失败');
    }
  }

  services.taskManager.dispatch(taskId);
  getEventBus().emit('message.received', { sessionId, message, taskId });

  // P0-B 整改：routing 进度走 EventBus，不再直写 socket
  getEventBus().emit('conversation.progress', {
    sessionId,
    taskId,
    status: 'routing',
    summary: '正在分析意图...',
  });

  logger.info({ sessionId, taskId, entry }, '正在处理用户消息 → Brain 路由');

  const availableAgents = buildAvailableAgentsList(services.registry);
  if (services.daemonBridge?.isAvailable) {
    for (const rt of services.daemonBridge.runtimes) {
      availableAgents.push({
        name: rt.name,
        taskTypes: ['external_code_task'],
        description: `外部 AI 编码智能体 (${rt.name} v${rt.version})`,
      });
    }
  }
  const sessionContext = services.sessionManager.getSessionContext(sessionId);
  const routePayload: RouteRequestPayload = {
    sessionId,
    message,
    taskId,
    availableAgents,
    sessionContext,
  };
  services.messageRouter.sendRouteRequest(routePayload, msgId);
}

/** handler helper 接收的 context（与 ws-handler.ts 调用契约匹配） */
interface MessageBusHandlerContext {
  channel?: WritableChannel;
  // 兼容 ws-handler 调用时的最小形状
  [key: string]: unknown;
}

/**
 * 处理 WS 路径的用户消息。
 * R8-1：从 messaging-handlers.ts 迁入。
 * 与 channel 入口共用 routeUserMessage helper，唯一差异：WS 路径需要 channel 回写 ack。
 */
export function handleMessage(
  request: Record<string, unknown>,
  channel: WritableChannel,
  services: ServiceContainer,
): void {
  const message = requireString(request, 'message');
  if (!message) {
    channel.write(JSON.stringify({ error: '缺少 message 字段' }) + '\n');
    return;
  }

  // 权限模式（与 messaging-handlers 同款：提取 effectiveMode 变量）
  const permissionMode = requireString(request, 'permissionMode');
  const effectiveMode = (permissionMode && ['ask', 'allow-all', 'deny-all'].includes(permissionMode))
    ? permissionMode as 'ask' | 'allow-all' | 'deny-all'
    : services.config.permissionMode;
  const permissionEngine = new PermissionEngine(effectiveMode);
  const approvalManager = new ApprovalManager(getDb(), new TokenIssuer(getDb()), effectiveMode);
  services.permissionCoordinator.updateEngine(permissionEngine);
  services.permissionCoordinator.updateApprovalManager(approvalManager);

  const sessionId = requireString(request, 'sessionId') ?? genId('ses');
  const clientMsgId = genId('umsg');

  // WS 路径：channel 路径不调用，所以 options.createWorkspace = true
  // 并发检查走通用分支，命中时通过 channel 写 error
  routeUserMessage(message, services as unknown as MessageBusHandlerContext, services, {
    sessionId,
    isStreaming: request.streaming !== false,
    clientMsgId,
    createWorkspace: true,
    entry: 'ws',
    onChannelBusy: () => {
      channel.write(JSON.stringify({ type: 'error', error: '该对话正在处理中，请等待完成', sessionId }) + '\n');
    },
  });
  // WS 路径特有：ask_user reply 路径需要写 ok ack
  if (services.sessionManager.hasPendingAsk(sessionId)) {
    channel.write(JSON.stringify({ ok: true, type: 'reply', sessionId }) + '\n');
  }
}

/**
 * 处理 Channel 路径的用户消息（Telegram / CLI / 未来 channel）。
 * R8-1：从 messaging-handlers.ts 迁入。
 * 与 WS 路径共用 routeUserMessage helper，唯一差异：channel 路径不创建 task workspace。
 */
export async function handleChannelMessage(
  userId: string,
  message: string,
  channelType: string,
  services: ServiceContainer,
): Promise<void> {
  const sessionId = `channel-${channelType}-${userId}`;
  const clientMsgId = genId('ch');

  // channel 入口并发错误回写到 channel 而不是 socket
  routeUserMessage(message, services as unknown as MessageBusHandlerContext, services, {
    sessionId,
    isStreaming: false,
    clientMsgId,
    createWorkspace: false,
    entry: 'channel',
    skipConcurrentCheck: false,
    onChannelBusy: () => {
      services.channelManager?.send(channelType, userId, { text: '该对话正在处理中，请等待完成' })
        .catch((err) => logger.warn({ err, channelType, userId }, 'channel 并发回写失败'));
    },
  });
}

const interruptHandler: HandlerFn = (request, ctx, services) => {
  const vals = requireFields(ctx, request, ['sessionId']);
  if (!vals) return;
  const [sessionId] = vals;

  const reason = typeof request.reason === 'string' ? request.reason : undefined;
  const result = services.messageRouter.interruptSession(sessionId, reason);

  const evt: SocketInterruptedEvent = {
    type: 'interrupted',
    sessionId,
    taskId: result.taskId,
    partialResponse: result.partialResponse,
  };
  reply(ctx, evt as unknown as Record<string, unknown>);
};

// === Daemon Handlers ===

function isValidRegister(msg: unknown): msg is DaemonRegisterMessage {
  const m = msg as Record<string, unknown>;
  return typeof m.daemonId === 'string' && typeof m.pid === 'number' && Array.isArray(m.runtimes)
    && typeof m.maxSlots === 'number' && typeof m.availableSlots === 'number';
}

function isValidHeartbeat(msg: unknown): msg is DaemonHeartbeatMessage {
  const m = msg as Record<string, unknown>;
  return typeof m.daemonId === 'string' && typeof m.availableSlots === 'number' && Array.isArray(m.runningTasks);
}

function isValidTaskMessage(msg: unknown): msg is { taskId: string } {
  const m = msg as Record<string, unknown>;
  return typeof m.taskId === 'string' && m.taskId.length > 0;
}

function isValidTaskResult(msg: unknown): msg is DaemonTaskResultMessage {
  const m = msg as Record<string, unknown>;
  return typeof m.taskId === 'string' && typeof m.ok === 'boolean' && typeof m.runtime === 'string';
}

const daemonRegisterHandler: HandlerFn = (request, ctx, services) => {
  if (!isValidRegister(request)) {
    logger.warn({ request }, 'Invalid daemon.register message');
    return;
  }
  services.daemonBridge!.handleRegister(request, ctx.socket!);
};

const daemonHeartbeatHandler: HandlerFn = (request, _ctx, services) => {
  if (!isValidHeartbeat(request)) {
    logger.warn('Invalid daemon.heartbeat message');
    return;
  }
  services.daemonBridge!.handleHeartbeat(request);
};

const daemonTaskClaimHandler: HandlerFn = (request, _ctx, services) => {
  if (!isValidTaskMessage(request)) {
    logger.warn('Invalid daemon.task.claim message');
    return;
  }
  services.daemonBridge!.handleTaskClaim(request as DaemonTaskClaimMessage);
};

const daemonTaskStartedHandler: HandlerFn = (request, _ctx, services) => {
  if (!isValidTaskMessage(request)) {
    logger.warn('Invalid daemon.task.started message');
    return;
  }
  services.daemonBridge!.handleTaskStarted(request as DaemonTaskStartedMessage);
};

const daemonTaskProgressHandler: HandlerFn = (request, _ctx, services) => {
  if (!isValidTaskMessage(request)) return;
  services.daemonBridge!.handleTaskProgress(request as DaemonTaskProgressMessage);
};

const daemonTaskResultHandler: HandlerFn = (request, _ctx, services) => {
  if (!isValidTaskResult(request)) {
    logger.warn('Invalid daemon.task.result message');
    return;
  }
  services.daemonBridge!.handleTaskResult(request);
};

const daemonDisconnectHandler: HandlerFn = (request, _ctx, services) => {
  const m = request as Record<string, unknown>;
  if (typeof m.daemonId !== 'string') {
    logger.warn('Invalid daemon.disconnect message');
    return;
  }
  services.daemonBridge!.handleDisconnect(request as unknown as DaemonDisconnectMessage);
};

// === Handler Registry ===

/**
 * socket-server 路径的 message handler（必须在 socketHandlers 数组之前定义以避免 TDZ）。
 *
 * R8-1 fix：socket-server 是 CLI / harness 的传输层。harness 不订阅 EventBus，
 * 等的是 'type: result' 消息（harness.ts:130）。所以 resolve 走 channelOverride
 * 同步直写 channel，保持 R5 行为。
 *
 * WS 路径由 WsEventBridge 订阅 'conversation.result' 事件后转发给 ws.send，
 * 真正的解耦形态。两条路径的"写响应"职责分别由对应 transport 承担。
 */
const socketServerMessageHandler: HandlerFn = (request, ctx, services) => {
  const message = requireString(request, 'message');
  if (!message) {
    reply(ctx, { error: '缺少 message 字段' });
    return;
  }
  // channel 已由 socket-server.ts 通过 MessageContext.channel 注入（WritableChannel）
  const channel = ctx.channel!;
  const sessionId = requireString(request, 'sessionId') ?? genId('ses');
  routeUserMessage(message, ctx as unknown as ServiceContainer, services, {
    sessionId,
    isStreaming: request.streaming !== false,
    clientMsgId: genId('umsg'),
    createWorkspace: true,
    entry: 'socket',
    channelOverride: channel, // 同步直写 channel（harness/CLI 期待）
    onChannelBusy: () => {
      channel.write(JSON.stringify({ type: 'error', error: '该对话正在处理中，请等待完成', sessionId }) + '\n');
    },
  });
  if (services.sessionManager.hasPendingAsk(sessionId)) {
    channel.write(JSON.stringify({ ok: true, type: 'reply', sessionId }) + '\n');
  }
};

export const socketHandlers: HandlerDefinition[] = [
  { type: 'status', handler: statusHandler },
  { type: 'health', handler: healthHandler },
  { type: 'logs.level.get', handler: getLogLevelHandler },
  { type: 'logs.level.set', handler: setLogLevelHandler },
  { type: 'permissions.list', handler: listPermissionsHandler },
  { type: 'permissions.approve', handler: resolvePermissionHandler },
  { type: 'permissions.deny', handler: resolvePermissionHandler },
  { type: 'permissions.cancel', handler: resolvePermissionHandler },
  { type: 'model.override', handler: modelOverrideHandler },
  { type: 'model.get', handler: modelGetHandler },
  { type: 'evolution.dispatch', handler: evolutionDispatchHandler },
  { type: 'agents.list', handler: agentsListHandler },
  { type: 'agents.inspect', handler: agentsInspectHandler },
  { type: 'agents.install', handler: agentsInstallHandler },
  { type: 'agents.remove', handler: agentsRemoveHandler },
  { type: 'agents.upgrade', handler: agentsUpgradeHandler },
  { type: 'agents.enable', handler: agentsEnableHandler },
  { type: 'agents.disable', handler: agentsDisableHandler },
  { type: 'agents.reload', handler: agentsReloadHandler },
  // R8-1 fix：恢复 'message' 类型 — socket-server 实际通过 message-bus
  // 路由 'socket:message' 到这里（line 264-278 socket-server.ts），不是死代码。
  // R7-1 报告说"socket-server 走的是 dispatch path 注入的 handleMessage 而非
  // registerAllHandlers 的 socketHandlers 列表"是误判：socket-server 走的就是
  // messageBus.send(busType, ...)，handler 必须注册到 socketHandlers 列表里。
  { type: 'message', handler: socketServerMessageHandler },
  { type: 'interrupt', handler: interruptHandler },
];

export const daemonHandlers: HandlerDefinition[] = [
  { type: 'daemon.register', handler: daemonRegisterHandler },
  { type: 'daemon.heartbeat', handler: daemonHeartbeatHandler },
  { type: 'daemon.task.claim', handler: daemonTaskClaimHandler },
  { type: 'daemon.task.started', handler: daemonTaskStartedHandler },
  { type: 'daemon.task.progress', handler: daemonTaskProgressHandler },
  { type: 'daemon.task.result', handler: daemonTaskResultHandler },
  { type: 'daemon.disconnect', handler: daemonDisconnectHandler },
];

export function registerAllHandlers(bus: MessageBus, services: ServiceContainer, includeDaemon: boolean): void {
  const all = includeDaemon ? [...socketHandlers, ...daemonHandlers] : socketHandlers;
  for (const { type, handler } of all) {
    const prefixed = `socket:${type}` as SocketMessageType;
    bus.handle(prefixed, (payload: Record<string, unknown>, ctx: MessageContext) => {
      return handler(payload, ctx, services);
    });
  }
}

// R8-1：handleMessage / handleChannelMessage 已迁入本文件并 export（routeUserMessage 上方）
// 不再 re-export from messaging-handlers.js（messaging-handlers.ts 即将删除）
