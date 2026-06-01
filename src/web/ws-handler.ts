import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocket } from 'ws';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import type { WebServerDependencies } from './types.js';

const logger = getLogger('ws-handler');

// --- Input validation helpers ---

function requireString(obj: Record<string, unknown>, field: string): string | undefined {
  const val = obj[field];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function wsReply(ws: WebSocket, data: Record<string, unknown>): void {
  if ((ws as unknown as { readyState: number }).readyState === 1) {
    logger.debug(data, 'ws:out');
    ws.send(JSON.stringify(data));
  }
}

function wsError(ws: WebSocket, error: string): void {
  wsReply(ws, { type: 'error', error });
}

// --- WebSocket Bridge ---

export class WebSocketBridge {
  destroyed = false;

  constructor(private ws: WebSocket) {
    ws.on('close', () => { this.destroyed = true; });
    ws.on('error', () => { this.destroyed = true; });
  }

  write(data: string): boolean {
    if ((this.ws as unknown as { readyState: number }).readyState === 1) {
      this.ws.send(data.replace(/\n$/, ''));
      return true;
    }
    return false;
  }

  end(): void {
    // ws stays open for next message — don't close
  }
}

// --- Connection handler ---

export function createWsHandler(deps: WebServerDependencies) {
  return function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? genId('ses');

    logger.debug({ sessionId }, 'WebSocket 连接');

    // Forward delegation events to this client
    const delegationListener = deps.eventBus.on('delegation.user_needed', (payload) => {
      wsReply(ws, { type: 'delegation.needed', ...payload });
    });

    // Forward permission confirmation events
    const permissionListener = deps.eventBus.on('permission.user_confirm_needed', (payload) => {
      wsReply(ws, { type: 'permission.confirm_needed', ...payload });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        logger.debug(msg, 'ws:in');
        handleWsMessage(ws, msg, sessionId, deps);
      } catch (err) {
        wsError(ws, (err as Error).message);
      }
    });

    const pingInterval = setInterval(() => {
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => {
      logger.debug({ sessionId }, 'WebSocket 断开');
      delegationListener();
      permissionListener();
      clearInterval(pingInterval);
    });
  };
}

// --- Message dispatcher ---

function handleWsMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  sessionId: string,
  deps: WebServerDependencies,
): void {
  const type = requireString(msg, 'type');
  if (!type) {
    wsError(ws, '缺少 type 字段');
    return;
  }

  switch (type) {
    case 'message': {
      const text = requireString(msg, 'text');
      if (!text) {
        wsError(ws, '消息内容不能为空');
        return;
      }
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined;
      const effectiveSessionId = requireString(msg, 'sessionId') || sessionId;
      const bridge = new WebSocketBridge(ws);
      deps.handleMessage(
        { message: text, sessionId: effectiveSessionId, streaming: true, permissionMode: 'ask', attachments },
        bridge as unknown as Socket,
      );
      break;
    }
    case 'permissions.approve': {
      const requestId = requireString(msg, 'requestId');
      if (!requestId) { wsError(ws, '缺少 requestId'); return; }
      deps.permissionCoordinator.resolve(requestId, {
        verdict: 'approved',
        source: 'user',
        tokenVerdict: 'allow_once',
      });
      deps.resolvePermissionConfirm?.(requestId, true);
      break;
    }
    case 'permissions.deny': {
      const requestId = requireString(msg, 'requestId');
      if (!requestId) { wsError(ws, '缺少 requestId'); return; }
      deps.permissionCoordinator.resolve(requestId, {
        verdict: 'denied',
        source: 'user',
        reason: typeof msg.reason === 'string' ? msg.reason : 'user denied via web dashboard',
      });
      deps.resolvePermissionConfirm?.(requestId, false, typeof msg.reason === 'string' ? msg.reason : undefined);
      break;
    }
    case 'interrupt': {
      const reason = typeof msg.reason === 'string' ? msg.reason : undefined;
      deps.handleInterrupt(sessionId, reason, ws);
      break;
    }
    case 'delegation.respond': {
      const delegationId = requireString(msg, 'delegationId');
      if (!delegationId) { wsError(ws, '缺少 delegationId'); return; }
      const response = typeof msg.response === 'string' ? msg.response : null;
      if (deps.humanDelegationManager) {
        const status = response ? 'approved' : 'denied';
        deps.humanDelegationManager.resolve(delegationId, response, status as 'approved' | 'denied');
        wsReply(ws, { type: 'delegation.resolved', delegationId, status });
      }
      break;
    }
    default:
      wsError(ws, `未知消息类型: ${type}`);
  }
}
