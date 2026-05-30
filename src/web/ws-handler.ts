import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocket } from 'ws';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import type { WebServerDependencies } from './types.js';

const logger = getLogger('ws-handler');

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

export function createWsHandler(deps: WebServerDependencies) {
  return function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? genId('ses');

    logger.debug({ sessionId }, 'WebSocket 连接');

    // Forward delegation events to this client
    const delegationListener = deps.eventBus.on('delegation.user_needed' as any, (payload: any) => {
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        ws.send(JSON.stringify({ type: 'delegation.needed', ...payload }));
      }
    });

    // Forward permission confirmation events
    const permissionListener = deps.eventBus.on('permission.user_confirm_needed' as any, (payload: any) => {
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        ws.send(JSON.stringify({ type: 'permission.confirm_needed', ...payload }));
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        handleWsMessage(ws, msg, sessionId, deps);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
      }
    });

    ws.on('close', () => {
      logger.debug({ sessionId }, 'WebSocket 断开');
      delegationListener();
      permissionListener();
    });

    const pingInterval = setInterval(() => {
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  };
}

function handleWsMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  sessionId: string,
  deps: WebServerDependencies,
): void {
  const type = msg.type as string;

  switch (type) {
    case 'message': {
      const text = msg.text as string;
      if (!text) {
        ws.send(JSON.stringify({ type: 'error', error: '消息内容不能为空' }));
        return;
      }
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined;
      const effectiveSessionId = (msg.sessionId as string) || sessionId;
      const bridge = new WebSocketBridge(ws);
      deps.handleMessage(
        { message: text, sessionId: effectiveSessionId, streaming: true, permissionMode: 'ask', attachments },
        bridge as unknown as Socket,
      );
      break;
    }
    case 'permissions.approve': {
      const requestId = msg.requestId as string;
      deps.permissionCoordinator.resolve(requestId, {
        verdict: 'approved',
        source: 'user',
        tokenVerdict: 'allow_once',
      });
      break;
    }
    case 'permissions.deny': {
      const requestId = msg.requestId as string;
      deps.permissionCoordinator.resolve(requestId, {
        verdict: 'denied',
        source: 'user',
        reason: (msg.reason as string) ?? 'user denied via web dashboard',
      });
      break;
    }
    case 'interrupt': {
      const reason = msg.reason as string | undefined;
      deps.handleInterrupt(sessionId, reason, ws);
      break;
    }
    case 'delegation.respond': {
      const delegationId = msg.delegationId as string;
      const response = msg.response as string | null;
      if (delegationId && deps.humanDelegationManager) {
        const status = response ? 'approved' : 'denied';
        deps.humanDelegationManager.resolve(delegationId, response, status as any);
        ws.send(JSON.stringify({ type: 'delegation.resolved', delegationId, status }));
      }
      break;
    }
    default:
      ws.send(JSON.stringify({ type: 'error', error: `未知消息类型: ${type}` }));
  }
}
