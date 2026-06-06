import type { Socket } from 'node:net';
import type { MessageBus } from '../message-bus.js';
import type { ServiceContainer } from '../service-container.js';
import type { SocketMessageType, MessageContext, MessageType } from '../../contracts/messages.js';
import { SocketChannel } from '../../contracts/transport.js';
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
      ctx.socket!.write(JSON.stringify({ ok: false, error: `缺少 ${f} 参数` }) + '\n');
      return null;
    }
    values.push(v);
  }
  return values;
}

function reply(ctx: MessageContext, data: Record<string, unknown>): void {
  ctx.socket!.write(JSON.stringify(data) + '\n');
}

function replyError(ctx: MessageContext, error: string): void {
  ctx.socket!.write(JSON.stringify({ ok: false, error }) + '\n');
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

const messageHandler: HandlerFn = (request, ctx, services) => {
  const message = requireString(request, 'message');
  const socket = ctx.socket!;
  if (!message) {
    reply(ctx, { error: '缺少 message 字段' });
    return;
  }

  const effectiveMode = (requireString(request, 'permissionMode') && ['ask', 'allow-all', 'deny-all'].includes(request.permissionMode as string))
    ? request.permissionMode as 'ask' | 'allow-all' | 'deny-all'
    : services.config.permissionMode;
  const permissionEngine = new PermissionEngine(effectiveMode);
  const approvalManager = new ApprovalManager(getDb(), new TokenIssuer(getDb()), effectiveMode);
  services.permissionCoordinator.updateEngine(permissionEngine);
  services.permissionCoordinator.updateApprovalManager(approvalManager);

  const sessionId = requireString(request, 'sessionId') ?? genId('ses');

  if (services.sessionManager.hasPendingAsk(sessionId)) {
    services.messageRouter.sendUserReply({
      sessionId,
      taskId: services.sessionManager.getPendingAsk(sessionId)!.taskId,
      reply: message,
    }, genId('reply'));
    socket.write(JSON.stringify({ ok: true, type: 'reply', sessionId }) + '\n');
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

  const isStreaming = request.streaming !== false;

  // P1-4: 将 Socket 包装为 WritableChannel 接口，统一 WS 和 CLI 传输层类型
  const channel = new SocketChannel(socket);

  // R4-P0-2：CLI / socket-server 路径的 user 消息也要在入口入库，避免孤儿
  try {
    const clientMsgId = genId('umsg');
    services.sessionManager.saveUserMessage(sessionId, message, { clientMsgId });
  } catch (err) {
    logger.warn({ err, sessionId, msgId }, 'unified-handlers 入口入库 user 消息失败');
  }

  services.sessionManager.createPending(msgId, {
    sessionId,
    userMessage: message,
    taskId,
    streaming: isStreaming,
    channel: isStreaming ? channel : undefined,
    resolve: (response) => {
      if (isStreaming) {
        const evt: SocketResultEvent = { type: 'result', response, sessionId, taskId };
        channel.write(JSON.stringify(evt) + '\n');
        channel.end();
      } else {
        channel.write(JSON.stringify({ response, sessionId, taskId }) + '\n');
      }
    },
  });

  const primaryName = services.registry.requireRole('primary').manifest.name;
  const agentHome = getAgentHomePath(primaryName);
  try {
    createTaskWorkspace(
      join(agentHome, 'tasks'),
      taskId,
      { sessionId, message, createdAt: Date.now() },
    );
  } catch (err) {
    logger.error({ err, taskId }, '创建任务工作空间失败');
  }

  services.taskManager.dispatch(taskId);
  getEventBus().emit('message.received', { sessionId, message, taskId });

  const pending = services.sessionManager.getPending(msgId)!;
  // P0-B 整改：routing 进度走 EventBus，不再直写 socket
  getEventBus().emit('conversation.progress', {
    sessionId,
    taskId,
    status: 'routing',
    summary: '正在分析意图...',
  });

  logger.info({ sessionId, taskId }, '正在处理用户消息 → Brain 路由');

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
};

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
  { type: 'message', handler: messageHandler },
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

export { handleChannelMessage } from './messaging-handlers.js';
