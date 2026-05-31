import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { ServiceContainer } from '../service-container.js';
import type { SocketProgressEvent, SocketResultEvent } from '../../contracts/socket-protocol.js';
import type { RouteRequestPayload } from '../../contracts/routing.js';
import { buildAvailableAgentsList } from '../agent-registry.js';
import { PermissionEngine } from '../../safety/permissions.js';
import { TokenIssuer } from '../../safety/token-issuer.js';
import { ApprovalManager } from '../../safety/approval-manager.js';
import { createTaskWorkspace } from '../task-workspace.js';
import { getAgentHomePath } from '../agent-home.js';
import { getDb } from '../../memory/db.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import { getEventBus } from '../event-bus.js';

const logger = getLogger('handlers:messaging');

function requireString(obj: Record<string, unknown>, field: string): string | undefined {
  const val = obj[field];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

export type MessagingHandlerContext = Pick<ServiceContainer,
  'agentManager' | 'registry' | 'taskManager' | 'taskRouter' |
  'sessionManager' | 'messageRouter' | 'permissionCoordinator' |
  'channelManager' | 'daemonBridge' | 'config'
>;

export function handleMessage(
  request: Record<string, unknown>,
  socket: Socket,
  ctx: MessagingHandlerContext,
): void {
  const message = requireString(request, 'message');
  if (!message) {
    socket.write(JSON.stringify({ error: '缺少 message 字段' }) + '\n');
    return;
  }

  const permissionMode = requireString(request, 'permissionMode');
  const effectiveMode = (permissionMode && ['ask', 'allow-all', 'deny-all'].includes(permissionMode))
    ? permissionMode as 'ask' | 'allow-all' | 'deny-all'
    : ctx.config.permissionMode;
  const permissionEngine = new PermissionEngine(effectiveMode);
  const approvalManager = new ApprovalManager(getDb(), new TokenIssuer(getDb()), effectiveMode);
  ctx.permissionCoordinator.updateEngine(permissionEngine);
  ctx.permissionCoordinator.updateApprovalManager(approvalManager);

  const sessionId = requireString(request, 'sessionId') ?? genId('ses');

  if (ctx.sessionManager.hasPendingAsk(sessionId)) {
    ctx.messageRouter.sendUserReply({
      sessionId,
      taskId: ctx.sessionManager.getPendingAsk(sessionId)!.taskId,
      reply: message,
    }, genId('reply'));
    socket.write(JSON.stringify({ ok: true, type: 'reply', sessionId }) + '\n');
    return;
  }

  const msgId = genId('msg');

  const route = ctx.taskRouter.route({ taskType: 'conversation_turn', requester: 'user' });
  const taskId = ctx.taskManager.create({
    sessionId,
    correlationId: msgId,
    taskType: 'conversation_turn',
    requester: 'user',
    targetAgent: route.targetAgent,
    foreground: true,
    inputPayload: { message, routeReason: route.reason },
  });

  const isStreaming = request.streaming !== false;

  ctx.sessionManager.createPending(msgId, {
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

  const primaryName = ctx.registry.requireRole('primary').manifest.name;
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

  ctx.taskManager.dispatch(taskId);
  getEventBus().emit('message.received', { sessionId, message, taskId });

  const pending = ctx.sessionManager.getPending(msgId)!;

  if (pending.streaming && pending.socket && !pending.socket.destroyed) {
    const event: SocketProgressEvent = { type: 'progress', status: 'routing', summary: '正在分析意图...', taskId };
    pending.socket.write(JSON.stringify(event) + '\n');
  }

  logger.info({ sessionId, taskId }, '正在处理用户消息 → Brain 路由');

  const availableAgents = buildAvailableAgentsList(ctx.registry);
  if (ctx.daemonBridge?.isAvailable) {
    for (const rt of ctx.daemonBridge.runtimes) {
      availableAgents.push({
        name: rt.name,
        taskTypes: ['external_code_task'],
        description: `外部 AI 编码智能体 (${rt.name} v${rt.version})`,
      });
    }
  }
  const sessionContext = ctx.sessionManager.getSessionContext(sessionId);
  const routePayload: RouteRequestPayload = {
    sessionId,
    message,
    taskId,
    availableAgents,
    sessionContext,
  };
  ctx.messageRouter.sendRouteRequest(routePayload, msgId);
}

export function handleChannelMessage(
  userId: string,
  message: string,
  channelType: string,
  ctx: MessagingHandlerContext,
): void {
  const sessionId = `channel-${channelType}-${userId}`;
  const msgId = genId('ch');

  if (ctx.sessionManager.hasPendingAsk(sessionId)) {
    ctx.messageRouter.sendUserReply({
      sessionId,
      taskId: ctx.sessionManager.getPendingAsk(sessionId)!.taskId,
      reply: message,
    }, genId('reply'));
    return;
  }

  const route = ctx.taskRouter.route({ taskType: 'conversation_turn', requester: 'user' });
  const taskId = ctx.taskManager.create({
    sessionId,
    correlationId: msgId,
    taskType: 'conversation_turn',
    requester: 'user',
    targetAgent: route.targetAgent,
    foreground: true,
    inputPayload: { message, routeReason: route.reason },
  });

  ctx.sessionManager.createPending(msgId, {
    sessionId,
    userMessage: message,
    taskId,
    streaming: false,
    resolve: (response) => {
      ctx.channelManager?.send(channelType, userId, { text: response }).catch((err) => {
        logger.error({ channelType, userId, err: (err as Error).message }, 'Channel 响应发送失败');
      });
    },
  });

  ctx.taskManager.dispatch(taskId);

  const availableAgents = buildAvailableAgentsList(ctx.registry);
  const sessionContext = ctx.sessionManager.getSessionContext(sessionId);
  const routePayload: RouteRequestPayload = {
    sessionId,
    message,
    taskId,
    availableAgents,
    sessionContext,
  };
  ctx.messageRouter.sendRouteRequest(routePayload, msgId);
}
