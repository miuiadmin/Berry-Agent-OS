import type { WebSocketServer, WebSocket } from 'ws';
import type { EventBus, EventName } from '../contracts/infrastructure.js';
import type { EventMap } from '../contracts/messages.js';

/**
 * WebSocket Event Bridge - 将 EventBus 事件桥接到 WS 客户端
 *
 * 两类事件，两种序列化格式：
 * 1. 全局事件（task.created / task.failed / scheduler.* / mcp.* 等）：
 *    包装为 { type: 'event', event, payload, ts }，前端通过 event 字段判断
 * 2. 流式事件（stream.* / dialogue.status / conversation.*）：
 *    顶层格式（payload 平铺到顶层 + ts），前端 onMessage 直接按 msg.type 分支
 *
 * P2-11: per-client sessionId 过滤
 * - WS 客户端发送 { type: 'subscribe', sessionId } 声明关注的对话
 * - 流式事件按 sessionId 过滤，只推送给订阅了该 sessionId 的客户端
 * - 全局事件（task.* / agent.* / scheduler.* / mcp.* / cron.*）仍广播给所有客户端
 * - 未订阅任何 sessionId 的客户端收到所有事件（兼容旧行为）
 */
const BRIDGED_EVENTS: EventName[] = [
  'task.created',
  'task.started',
  'task.completed',
  'task.failed',
  'task.timeout',
  'task.cancelled',
  'task.progress',
  'agent.enabled',
  'agent.disabled',
  'agent.crashed',
  'config.reloaded',
  'daemon.connected',
  'daemon.disconnected',
  'daemon.task.progress',
  'daemon.task.completed',
  'daemon.task.failed',
  // Notification events
  'notification.created',
  'notification.read',
  // Scheduler events
  'scheduler.job_enqueued',
  'scheduler.job_claimed',
  'scheduler.job_completed',
  'scheduler.job_failed',
  'scheduler.chain_step_completed',
  'scheduler.chain_approval_pending',
  'scheduler.reminder_fired',
  'scheduler.webhook_received',
  // MCP events
  'mcp.connected',
  'mcp.disconnected',
  'mcp.failed',
  'mcp.tools_changed',
  // Cron events
  'cron.fired',
  'cron.completed',
  'cron.failed',
];

/**
 * 流式事件：payload 顶层化（让前端 onMessage 直接按 msg.type 分支）
 * 命名映射：EventBus 事件名 → ws 客户端消息 type
 */
const STREAM_EVENT_MAPPING: Partial<Record<EventName, string>> = {
  'stream.text_delta': 'text_delta',
  'stream.reasoning_delta': 'reasoning_delta',
  'stream.tool_call': 'tool_call',
  'stream.tool_result': 'tool_result',
  'stream.uncertainty': 'uncertainty',
  'dialogue.status': 'dialogue_status',
  // delegation-orchestrator 内部事件：保持类型名稳定，前端按 sessionId 过滤
  'conversation.handoff': 'agent_handoff',
  'conversation.ask_user': 'ask_user',
  'conversation.progress': 'progress',
  'conversation.no_response': 'no_response',
  /** P0-3: 对话中断通知 — 通过 EventBus 投递，不再直写 ws */
  'conversation.interrupted': 'interrupted',
  /** P1-5: 对话最终结果 — WS 路径通过 EventBus 投递，resolve 不再直写 channel */
  'conversation.result': 'result',
};

export class WsEventBridge {
  private unsubscribes: Array<() => void> = [];

  /**
   * P2-11: per-client sessionId 订阅映射。
   * key = WebSocket 实例，value = 该客户端订阅的 sessionId 集合。
   * 未订阅（集合为空）的客户端收到所有事件（兼容旧行为）。
   * 客户端断连后自动清理。
   */
  private clientSubscriptions = new WeakMap<WebSocket, Set<string>>();

  constructor(private wss: WebSocketServer, eventBus: EventBus) {
    // P2-11: 监听新 WS 连接，注册 subscribe 消息处理和断连清理
    this.wss.on('connection', (ws) => {
      this.clientSubscriptions.set(ws, new Set());
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          // 客户端发送 { type: 'subscribe', sessionId } 注册关注的对话
          if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') {
            this.clientSubscriptions.get(ws)?.add(msg.sessionId);
          }
          // 客户端发送 { type: 'unsubscribe', sessionId } 取消关注
          if (msg.type === 'unsubscribe' && typeof msg.sessionId === 'string') {
            this.clientSubscriptions.get(ws)?.delete(msg.sessionId);
          }
        } catch { /* 非 JSON 消息忽略 */ }
      });
      ws.on('close', () => {
        this.clientSubscriptions.delete(ws);
      });
    });

    // 1. 全局事件：包装格式 — 广播给所有客户端（这些事件不绑定 sessionId）
    for (const event of BRIDGED_EVENTS) {
      const unsub = eventBus.on(event, (payload) => {
        const msg = JSON.stringify({ type: 'event', event, payload, ts: Date.now() });
        this.broadcast(msg);
      });
      this.unsubscribes.push(unsub);
    }

    // 2. 流式事件：顶层格式 + 按 sessionId 过滤
    for (const [eventName, wsType] of Object.entries(STREAM_EVENT_MAPPING)) {
      const unsub = eventBus.on(eventName as EventName, (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const msg = JSON.stringify({ type: wsType, ...p, ts: Date.now() });
        const sessionId = p.sessionId as string | undefined;
        // 流式事件按 sessionId 过滤：只发给订阅了该 sessionId 的客户端
        this.broadcastFiltered(msg, sessionId);
      });
      this.unsubscribes.push(unsub);
    }
  }

  /** 广播一条消息给所有 readyState=1 (OPEN) 的 ws 客户端 */
  private broadcast(msg: string): void {
    for (const client of this.wss.clients) {
      if ((client as unknown as { readyState: number }).readyState === 1) {
        (client as WebSocket).send(msg);
      }
    }
  }

  /**
   * P2-11: 按 sessionId 过滤广播。
   * - 有 sessionId 的事件：只发给订阅了该 sessionId 的客户端，以及未订阅任何 session 的客户端（兼容旧版）
   * - 无 sessionId 的事件：广播给所有客户端
   */
  private broadcastFiltered(msg: string, sessionId: string | undefined): void {
    for (const client of this.wss.clients) {
      if ((client as unknown as { readyState: number }).readyState !== 1) continue;
      const subs = this.clientSubscriptions.get(client as WebSocket);
      // 未注册订阅信息（连接建立前的老连接）或订阅集合为空 → 接收所有
      if (!subs || subs.size === 0) {
        (client as WebSocket).send(msg);
        continue;
      }
      // 有订阅 → 只接收匹配 sessionId 的事件
      if (sessionId && subs.has(sessionId)) {
        (client as WebSocket).send(msg);
      }
    }
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }
}
