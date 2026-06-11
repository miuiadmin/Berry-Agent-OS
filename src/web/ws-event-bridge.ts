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
  // 13.0 多智能体协作：任务生命周期事件（全局广播，前端实时更新任务进度）
  'mission.created',
  'mission.status_changed',
  'mission.task_updated',
  'mission.task_ready',
  'mission.completed',
  'mission.squad_created',
  'mission.signal',
  'mission.handoff',
  // 13.0 自进化触发（Brain 在 plan 中发现需要新技能时）
  'capability.evolution.request',
  // 13.0 §13.9: cron 任务完成后的 review 触发（Brain 订阅后可独立审核 cron 输出）
  'cron.review',
  // 13.0 §5.1.3: Brain 纠偏事件（全局广播，前端 UI 可显示纠偏时间线）
  'brain.correction',
  // 13.0 §11.5: 跨 squad 交接（结构化 handoff 通知）
  'brain.handoff',
  // 13.0 P9: Brain 观察 blocker/question signal 后触发的 INTERVENE 事件
  'brain.signal_intervention',
  // 13.0 §5.3.10: Agent 目录变更推送
  'directory.changed',
  // 13.0 P10: Brain 派发 checker 独立审核事件
  'brain.checker.dispatch',
  // 13.0 §13.16: 长任务心跳（前端显示「还在工作中」提示）
  'task.heartbeat',
  // 13.0 §5.3.4: 用户反馈 Brain 审核问题（前端可据此更新 UI 状态）
  'brain.feedback',
  // 13.0 §13.8: cron 任务 LLM 审核标记（前端展示 cron 输出审核警告）
  'brain.cron_review_flagged',
  // 13.0 §13.5: 用户会话排队/出队（前端显示「你的消息已排队，请等待」提示）
  'user.session.queued',
  'user.session.dequeued',
  // 13.0 §8.7: Agent 拒绝任务（前端显示任务被拒绝及原因）
  'task.reject',
  // 13.0: 委托生命周期（前端实时显示任务完成/失败状态）
  'delegation.completed',
  'delegation.failed',
  // 13.0 §13.18: 插件工具变更广播（前端可据此刷新工具面板）
  'tools.updated',
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
  /** 13.0 灵魂版：Agent 间对话每条消息推送（与 dialogue.status 互补） */
  'agent.dialogue': 'agent_dialogue',
  // delegation-orchestrator 内部事件：保持类型名稳定，前端按 sessionId 过滤
  'conversation.handoff': 'agent_handoff',
  'conversation.ask_user': 'ask_user',
  'conversation.progress': 'progress',
  'conversation.no_response': 'no_response',
  /** P0-3: 对话中断通知 — 通过 EventBus 投递，不再直写 ws */
  'conversation.interrupted': 'interrupted',
  /** P1-5: 对话最终结果 — WS 路径通过 EventBus 投递，resolve 不再直写 channel */
  'conversation.result': 'result',
  /** 13.0 灵魂版：对话完成后附带 Brain 审核裁决（verdict/reason/originalDraft） */
  'message.responded': 'review_info',
  /** P3: 权限确认请求 — 全局广播替代 per-connection listener，断连期间新请求不丢失 */
  'permission.user_confirm_needed': 'permission.confirm_needed',
  /** P3: 人工委托请求 — 全局广播替代 per-connection listener，断连期间新请求不丢失 */
  'delegation.user_needed': 'delegation.needed',
  // 13.0 §4.4.2: 跨 agent 预算告警（per-agent token 实时推送 — 顶层格式 + sessionId 过滤）
  'brain.budget.alert': 'budget_alert',
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
        try {
          (client as WebSocket).send(msg);
        } catch {
          // TOCTOU 竞争窗口：readyState 检查后、send() 前客户端可能断连，忽略
        }
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
        try {
          (client as WebSocket).send(msg);
        } catch {
          // 客户端在 readyState 检查后断连，忽略
        }
        continue;
      }
      // 有订阅 → 只接收匹配 sessionId 的事件
      if (sessionId && subs.has(sessionId)) {
        try {
          (client as WebSocket).send(msg);
        } catch {
          // 客户端在 readyState 检查后断连，忽略
        }
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
