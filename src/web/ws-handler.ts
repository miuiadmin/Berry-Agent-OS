import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import type { WebServerDependencies } from './types.js';
import type { WritableChannel } from '../contracts/transport.js';

const logger = getLogger('ws-handler');

/** R11-P1：WS payload 字节数上限。超过显式拒绝 + 关闭连接。 */
const MAX_WS_PAYLOAD_BYTES = 256 * 1024; // 256KB

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
      try {
        this.ws.send(data.replace(/\n$/, ''));
        return true;
      } catch {
        // TOCTOU 竞争窗口：readyState 检查后、send() 前客户端可能断连
        return false;
      }
    }
    return false;
  }

  end(): void {
    // ws stays open for next message — don't close
  }
}

// --- P2-10: Reconnect replay ---

/**
 * WS 连接（含重连）时重放未决的 delegation 和 permission 请求。
 *
 * 当 WS 断连期间触发 delegation.user_needed / permission.user_confirm_needed 时，
 * per-connection 监听器已清理，消息被静默丢弃。重连后从 SQLite 查询 pending 状态的请求，
 * 重新推送给客户端，避免用户错失操作提示（默认 5 分钟超时自动拒绝）。
 */
function replayPendingRequests(ws: WebSocket, deps: WebServerDependencies): void {
  try {
    // 1. 重放未决的委托请求（human_delegations 表）
    if (deps.humanDelegationManager) {
      const pendingDelegations = deps.humanDelegationManager.getPending();
      for (const d of pendingDelegations) {
        // 检查是否已超时（创建时间 + timeoutMs < 当前时间）
        if (d.createdAt + d.timeoutMs < Date.now()) continue;
        wsReply(ws, {
          type: 'delegation.needed',
          delegationId: d.id,
          sessionId: d.sessionId,
          requestedBy: d.requestedBy,
          title: d.title,
          description: d.description,
          urgency: d.urgency,
          options: d.options,
        });
        logger.debug({ delegationId: d.id, clientId: ws.url }, 'WS 重连重放未决委托');
      }
    }

    // 2. 重放未决的权限确认请求（approval_requests 表）
    // permissionCoordinator.getPending() 返回 status='pending' 的 ApprovalRequest[]
    // 只重放高风险的（dangerous 级别才触发 permission.user_confirm_needed）
    const pendingPermissions = deps.permissionCoordinator.getPending();
    for (const p of pendingPermissions) {
      // 只重放高风险且未过期的请求
      if (p.riskLevel !== 'high') continue;
      if (p.expiresAt && p.expiresAt < Date.now()) continue;
      // 从 requestPayload 提取工具信息
      let toolName = '';
      let toolInput = '';
      try {
        const payload = p.requestPayload;
        toolName = (payload?.toolName ?? payload?.tool ?? '') as string;
        toolInput = typeof payload?.toolInput === 'string' ? payload.toolInput as string : JSON.stringify(payload?.toolInput ?? '');
      } catch { /* 解析失败用空值 */ }
      wsReply(ws, {
        type: 'permission.confirm_needed',
        requestId: p.id,
        sessionId: p.sessionId,
        agentName: p.requester,
        toolName,
        toolInput: toolInput.slice(0, 500),
        dangerLevel: p.riskLevel,
        brainReason: '危险操作，需要用户确认（重连恢复）',
      });
      logger.debug({ requestId: p.id }, 'WS 重连重放未决权限确认');
    }

    // 3. 重放未决的 ask_user 请求（直接从 SQLite 查询，
    // 与前两类 delegation/permissions 保持一致：replay 统一从 DB 读取）。
    // 消息格式与 WsEventBridge 的 STREAM_EVENT_MAPPING 中
    // conversation.ask_user → ask_user 一致，前端可复用同一处理逻辑。
    const pendingAsks = deps.sessionManager.getAllPendingAsksFromDb();
    for (const ask of pendingAsks) {
      wsReply(ws, {
        type: 'ask_user',
        sessionId: ask.sessionId,
        taskId: ask.taskId,
        agent: ask.agentName,
        question: ask.question,
        correlationId: ask.correlationId,
      });
      logger.debug({ sessionId: ask.sessionId, correlationId: ask.correlationId }, 'WS 重连重放未决 ask_user');
    }
  } catch (err) {
    logger.warn({ err }, 'WS 重连重放未决请求失败');
  }
}

// --- Connection handler ---

export function createWsHandler(deps: WebServerDependencies) {
  return function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // WS 连接用 clientId 标识客户端（每个浏览器标签页独立，存在 sessionStorage）
    const clientId = url.searchParams.get('clientId') ?? genId('client');

    logger.debug({ clientId }, 'WebSocket 连接');

    // P3: permission/delegation 事件已迁移到 WsEventBridge 全局广播，
    // 不再需要 per-connection EventBus listener

    // P2-10: WS 重连安全网 — 即使事件现在通过 WsEventBridge 全局广播，
    // 重放从 SQLite 查询的 pending 状态请求仍作为幂等兜底（防止事件在
    // WS 断连窗口期被广播但该客户端未订阅到）。
    replayPendingRequests(ws, deps);

    ws.on('message', (data) => {
      // R11-P1：payload size limit 防 DoS / 污染
      // 默认 256KB。超过显式拒绝 + 关闭连接（恶意客户端会反复发大 payload）
      // ws.RawData 类型：Buffer | ArrayBuffer | Buffer[]，统一用 byteLength 取
      const size = Buffer.isBuffer(data) ? data.length
        : Array.isArray(data) ? Buffer.concat(data).length
        : (data as ArrayBuffer).byteLength;
      if (size > MAX_WS_PAYLOAD_BYTES) {
        logger.warn({ clientId, size, max: MAX_WS_PAYLOAD_BYTES }, 'WS 消息超 size limit，关闭连接');
        ws.close(1009, 'message too large');
        return;
      }
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
      clearInterval(pingInterval);
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
      // R15: 回写 sessionId 让前端知道后端使用的 sessionId（新对话时前端传 null）
      if (!requireString(msg, 'sessionId')) {
        wsReply(ws, { type: 'session_created', sessionId: effectiveSessionId });
      }
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
