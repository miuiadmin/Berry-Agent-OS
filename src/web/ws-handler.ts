import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import type { WebServerDependencies } from './types.js';
import type { WritableChannel } from '../contracts/transport.js';

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

/**
 * WebSocket → WritableChannel 桥接器
 * 将 ws.WebSocket 适配为统一的 WritableChannel 接口，
 * 消除 kernel 层对 WS 传输层具体类型的依赖。
 */
export class WebSocketBridge implements WritableChannel {
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
    // WS 连接用 clientId 标识客户端（每个浏览器标签页独立，存在 sessionStorage）
    const clientId = url.searchParams.get('clientId') ?? genId('client');

    logger.debug({ clientId }, 'WebSocket 连接');

    // P0-C 修复：删除 rebindSocket 调用 — 重连恢复由前端 sharedSessionRestore 走 HTTP 拉历史 + 续接 WS live tail 解决
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
        handleWsMessage(ws, msg, clientId, deps);
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

    ws.on('close', (code, reason) => {
      // 调试日志：定位 WS 断连原因（code 1001=浏览器关闭/刷新，1006=异常断开，1000=正常关闭）
      logger.info({
        clientId,
        code,
        reason: reason.toString() || '无',
      }, 'WebSocket 断开');
      delegationListener();
      permissionListener();
      clearInterval(pingInterval);

      // P0-2 修复：清理该 clientId 关联的 pending request 的 channel 引用
      // 对话继续运行不中断（保证稳定性），仅清除死 channel 引用避免 resolve 闭包写入已断连连接
      let cleanedCount = 0;
      for (const [msgId, pending] of deps.sessionManager.entries()) {
        if (pending.clientId === clientId) {
          // 清除 channel 引用 — WebSocketBridge.write() 已有安全检查，但显式清除更明确
          pending.channel = undefined;
          cleanedCount++;
          logger.debug({
            clientId,
            msgId,
            sessionId: pending.sessionId,
            hasTaskId: !!pending.taskId,
          }, 'WS 断连：清理 pending request channel 引用，对话继续运行');
          }
      }
      if (cleanedCount > 0) {
        logger.info({ clientId, cleanedCount }, 'WS 断连：已清理关联的 pending request，对话继续运行等待重连恢复');
      }
    });
  };
}

// --- Message dispatcher ---

/**
 * 处理 WS 消息。clientId 是 WS 传输层标识，用于关联 pending request。
 * 对话 sessionId 完全由消息体携带。
 */
function handleWsMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  clientId: string,
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
      // 对话 sessionId 来自消息体，不再依赖 WS URL 参数
      const effectiveSessionId = requireString(msg, 'sessionId') || genId('ses');
      const permissionMode = requireString(msg, 'permissionMode') || 'ask';
      const bridge = new WebSocketBridge(ws);
      // P1-4 修复：WebSocketBridge 实现 WritableChannel，不再需要 unsafe cast
      // 传递 clientId 以便 session-manager 按 WS 客户端索引 pending request
      deps.handleMessage(
        { message: text, sessionId: effectiveSessionId, streaming: true, permissionMode, attachments, clientId },
        bridge,
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
      // 中断目标由消息体的 sessionId 指定（对话级别），与 WS 客户端标识无关
      const interruptSessionId = requireString(msg, 'sessionId');
      if (!interruptSessionId) { wsError(ws, '缺少 sessionId'); return; }
      const reason = typeof msg.reason === 'string' ? msg.reason : undefined;
      // P0-3 修复：handleInterrupt 不再需要 ws 参数，中断通知通过 EventBus 投递
      deps.handleInterrupt(interruptSessionId, reason);
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
