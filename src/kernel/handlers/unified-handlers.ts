import type { Socket } from 'node:net';
import type { MessageBus } from '../message-bus.js';
import type { ServiceContainer } from '../service-container.js';
import type { SocketMessageType, MessageContext } from '../../contracts/messages.js';
import type {
  DaemonRegisterMessage,
  DaemonHeartbeatMessage,
  DaemonTaskClaimMessage,
  DaemonTaskStartedMessage,
  DaemonTaskProgressMessage,
  DaemonTaskResultMessage,
  DaemonDisconnectMessage,
} from '../../contracts/daemon-protocol.js';
import type { SocketProgressEvent, SocketResultEvent, SocketInterruptedEvent } from '../../contracts/socket-protocol.js';
import type { RouteRequestPayload } from '../../contracts/routing.js';
import type { ModelTier } from '../../contracts/model.js';
import type { LogLevel } from '../observability.js';
import { PermissionEngine } from '../../safety/permissions.js';
import { TokenIssuer } from '../../safety/token-issuer.js';
import { ApprovalManager } from '../../safety/approval-manager.js';
import { buildAvailableAgentsList } from '../agent-registry.js';
import { createTaskWorkspace } from '../task-workspace.js';
import { getAgentHomePath } from '../agent-home.js';
import { getUserAgentsDir } from '../../utils/paths.js';
import { getDb } from '../../memory/db.js';
import { genId } from '../../utils/id.js';
import { getEventBus } from '../event-bus.js';
import { metrics } from '../../observability/metrics.js';
import { getLogger } from '../../utils/logger.js';
import { join } from 'node:path';

const logger = getLogger('unified-handlers');

type HandlerFn = (request: Record<string, unknown>, ctx: MessageContext, services: ServiceContainer) => void | Promise<void>;

interface HandlerDefinition {
  type: string;
  handler: HandlerFn;
}

// === Observability Handlers ===

const statusHandler: HandlerFn = (_, ctx, services) => {
  const status = services.agentManager.getStatus();
  const daemon = services.getDaemonStatus?.() ?? null;
  ctx.socket!.write(JSON.stringify({ status, daemon }) + '\n');
};

const healthHandler: HandlerFn = (_, ctx, services) => {
  const agentStatus = services.agentManager.getStatus();
  const metricsSnapshot = metrics.snapshot();
  const evolutionFailures = services.memoryRuntime.getEvolutionFailures();
  ctx.socket!.write(JSON.stringify({
    ok: true,
    uptimeMs: metricsSnapshot.uptimeMs,
    agents: agentStatus,
    evolutionFailures,
    metrics: metricsSnapshot,
  }) + '\n');
};

const getLogLevelHandler: HandlerFn = (_, ctx, services) => {
  ctx.socket!.write(JSON.stringify({ level: services.getLogLevel(), source: 'runtime' }) + '\n');
};

const setLogLevelHandler: HandlerFn = (request, ctx, services) => {
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const level = request.level as string;
  if (!validLevels.includes(level as LogLevel)) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '无效的日志等级' }) + '\n');
    return;
  }
  const previousLevel = services.getLogLevel();
  services.setLogLevel(level as LogLevel);

  const existingTimer = services.getLogLevelResetTimer();
  if (existingTimer) {
    clearTimeout(existingTimer);
    services.setLogLevelResetTimer(null);
  }

  const ttl = request.ttl as string | undefined;
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
  ctx.socket!.write(JSON.stringify({ ok: true, level: services.getLogLevel(), previous: previousLevel }) + '\n');
};

// === Permission Handlers ===

const listPermissionsHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = request.sessionId as string | undefined;
  const pending = services.permissionCoordinator.getPending(sessionId) ?? [];
  ctx.socket!.write(JSON.stringify({ ok: true, pending }) + '\n');
};

const resolvePermissionHandler: HandlerFn = (request, ctx, services) => {
  const requestId = request.requestId as string;
  const type = request.type as string;
  if (!requestId) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 requestId' }) + '\n');
    return;
  }

  if (type === 'permissions.cancel') {
    const cancelled = services.permissionCoordinator.cancel(requestId) ?? false;
    ctx.socket!.write(JSON.stringify({ ok: cancelled }) + '\n');
    return;
  }

  const token = services.permissionCoordinator.resolve(requestId, {
    verdict: type === 'permissions.approve' ? 'approved' : 'denied',
    source: 'user',
    reason: request.reason as string | undefined,
    tokenVerdict: request.allowSession ? 'allow_session' : 'allow_once',
  }) ?? null;
  ctx.socket!.write(JSON.stringify({ ok: true, tokenId: token?.id ?? null }) + '\n');
};

// === Model Handlers ===

const modelOverrideHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = (request.sessionId as string) ?? '';
  const tier = request.tier as string;
  if (!tier || !['fast', 'default', 'high'].includes(tier)) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '无效的模型层级，可选: fast / default / high' }) + '\n');
    return;
  }
  services.sessionManager.setModelOverride(sessionId, tier as ModelTier);
  ctx.socket!.write(JSON.stringify({ ok: true, sessionId, tier }) + '\n');
};

const modelGetHandler: HandlerFn = (request, ctx, services) => {
  const sessionId = (request.sessionId as string) ?? '';
  const tier = services.sessionManager.getModelOverride(sessionId) ?? 'default';
  const models = services.config.llm.models;
  ctx.socket!.write(JSON.stringify({
    ok: true,
    sessionId,
    currentTier: tier,
    models: {
      fast: models.fast ?? services.config.llm.model,
      default: models.default ?? services.config.llm.model,
      high: models.high ?? services.config.llm.model,
    },
  }) + '\n');
};

const evolutionDispatchHandler: HandlerFn = (request, ctx, services) => {
  const taskType = request.taskType as string;
  if (!taskType) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 taskType' }) + '\n');
    return;
  }
  services.messageRouter.dispatchModuleTask({
    sessionId: (request.sessionId as string) ?? genId('ses'),
    taskType,
    requester: (request.requester as string) ?? 'cli',
    inputPayload: (request.inputPayload as Record<string, unknown>) ?? {},
  })
    .then((result) => ctx.socket!.write(JSON.stringify({ ok: true, ...result }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

// === Agent Handlers ===

const agentsListHandler: HandlerFn = (request, ctx, services) => {
  const rows = services.agentLifecycle.list({
    source: request.source as string | undefined,
    status: request.status as string | undefined,
  });
  ctx.socket!.write(JSON.stringify({ ok: true, agents: rows }) + '\n');
};

const agentsInspectHandler: HandlerFn = (request, ctx, services) => {
  const name = request.name as string;
  if (!name) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 name 参数' }) + '\n');
    return;
  }
  const detail = services.agentLifecycle.inspect(name);
  if (!detail) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: `智能体不存在: ${name}` }) + '\n');
    return;
  }
  ctx.socket!.write(JSON.stringify({ ok: true, agent: detail }) + '\n');
};

const agentsInstallHandler: HandlerFn = (request, ctx, services) => {
  const dir = request.dir as string;
  if (!dir) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 dir 参数' }) + '\n');
    return;
  }
  services.agentLifecycle.install(dir)
    .then((result) => ctx.socket!.write(JSON.stringify({ ok: true, ...result }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

const agentsRemoveHandler: HandlerFn = (request, ctx, services) => {
  const name = request.name as string;
  if (!name) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 name 参数' }) + '\n');
    return;
  }
  services.agentLifecycle.remove(name, { force: request.force === true })
    .then(() => ctx.socket!.write(JSON.stringify({ ok: true, name }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

const agentsUpgradeHandler: HandlerFn = (request, ctx, services) => {
  const name = request.name as string;
  if (!name) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 name 参数' }) + '\n');
    return;
  }
  services.agentLifecycle.upgrade(name)
    .then((result) => ctx.socket!.write(JSON.stringify({ ok: true, name, ...result }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

const agentsEnableHandler: HandlerFn = (request, ctx, services) => {
  const name = request.name as string;
  if (!name) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 name 参数' }) + '\n');
    return;
  }
  services.agentLifecycle.enable(name)
    .then(() => ctx.socket!.write(JSON.stringify({ ok: true, name }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

const agentsDisableHandler: HandlerFn = (request, ctx, services) => {
  const name = request.name as string;
  if (!name) {
    ctx.socket!.write(JSON.stringify({ ok: false, error: '缺少 name 参数' }) + '\n');
    return;
  }
  services.agentLifecycle.disable(name, request.reason as string | undefined)
    .then(() => ctx.socket!.write(JSON.stringify({ ok: true, name }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

const agentsReloadHandler: HandlerFn = (_, ctx, services) => {
  services.agentLifecycle.reload(getUserAgentsDir())
    .then((result) => ctx.socket!.write(JSON.stringify({ ok: true, ...result }) + '\n'))
    .catch((err) => ctx.socket!.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n'));
};

// === Messaging Handlers ===

const messageHandler: HandlerFn = (request, ctx, services) => {
  const message = request.message as string;
  const socket = ctx.socket!;
  if (!message) {
    socket.write(JSON.stringify({ error: '缺少 message 字段' }) + '\n');
    return;
  }

  const effectiveMode = (request.permissionMode && ['ask', 'allow-all', 'deny-all'].includes(request.permissionMode as string))
    ? request.permissionMode as 'ask' | 'allow-all' | 'deny-all'
    : services.config.permissionMode;
  const permissionEngine = new PermissionEngine(effectiveMode);
  const approvalManager = new ApprovalManager(getDb(), new TokenIssuer(getDb()), effectiveMode);
  services.permissionCoordinator.updateEngine(permissionEngine);
  services.permissionCoordinator.updateApprovalManager(approvalManager);

  const sessionId = (request.sessionId as string) ?? genId('ses');

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

  services.sessionManager.createPending(msgId, {
    sessionId,
    userMessage: message,
    taskId,
    streaming: isStreaming,
    socket: isStreaming ? socket : undefined,
    resolve: (response) => {
      if (isStreaming) {
        const evt: SocketResultEvent = { type: 'result', response, sessionId, taskId };
        socket.write(JSON.stringify(evt) + '\n');
        socket.end();
      } else {
        socket.write(JSON.stringify({ response, sessionId, taskId }) + '\n');
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
  if (pending.streaming && pending.socket && !pending.socket.destroyed) {
    const event: SocketProgressEvent = { type: 'progress', status: 'routing', summary: '正在分析意图...', taskId };
    pending.socket.write(JSON.stringify(event) + '\n');
  }

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
  const sessionId = request.sessionId as string;
  const socket = ctx.socket!;
  if (!sessionId) {
    socket.write(JSON.stringify({ error: '缺少 sessionId 字段' }) + '\n');
    return;
  }

  const reason = request.reason as string | undefined;
  const result = services.messageRouter.interruptSession(sessionId, reason);

  const evt: SocketInterruptedEvent = {
    type: 'interrupted',
    sessionId,
    taskId: result.taskId,
    partialResponse: result.partialResponse,
  };
  socket.write(JSON.stringify(evt) + '\n');
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
    const prefixed = `socket:${type}` as any;
    bus.handle(prefixed, (payload: Record<string, unknown>, ctx: MessageContext) => {
      return handler(payload, ctx, services);
    });
  }
}

export { handleChannelMessage } from './messaging-handlers.js';
