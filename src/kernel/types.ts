// === IPC Infrastructure (kernel-owned) ===

export interface IpcMessage<T = unknown> {
  id: string;
  correlationId?: string;
  type: IpcMessageType;
  from: string;
  to: string;
  payload: T;
  timestamp: number;
  traceId?: string;
  spanId?: string;
  priority?: number;
}

export type IpcMessageType =
  | 'agent.register'
  | 'agent.heartbeat'
  | 'user.message'
  | 'draft.response'
  | 'review.request'
  | 'review.result'
  | 'final.response'
  | 'agent.shutdown'
  | 'permission.request'
  | 'permission.result'
  | 'permission.validate'
  | 'permission.consume'
  | 'permission.acquire'
  | 'permission.judge'
  | 'permission.judge.result'
  | 'tool.audit'
  | 'memory.query'
  | 'memory.add'
  | 'memory.delete'
  | 'user.remember_preference'
  | 'user.get_preferences'
  | 'capability.request'
  | 'capability.response'
  | 'task.acknowledge'
  | 'agent.task'
  | 'agent.task.result'
  | 'task.started'
  | 'task.progress'
  | 'route.request'
  | 'route.result'
  | 'agent.ask_user'
  | 'agent.user_reply'
  | 'model.takeover.request'
  | 'model.takeover.respond'
  | 'model.override'
  | 'plugins.register_tools'
  | 'plugin.execute'
  | 'plugin.execute.result'
  | 'skill.changed'
  | 'task.cancel'
  | 'task.telemetry'
  | 'checkpoint.evaluate'
  | 'checkpoint.evaluate.result'
  | 'turn.correction'
  | 'superior.review.request'
  | 'conversation.restore'
  | 'brain.review.feedback'
  | 'brain.review.feedback.result'
  | 'superior.review.result'
  | 'bus.invoke'
  | 'bus.invoke.result'
  | 'bus.capabilities.request'
  | 'bus.capabilities.response'
  | 'config.llm_update'
  // 11.0 智能体间对话协议
  | 'dialogue.send'
  | 'dialogue.reply'
  | 'dialogue.end'
  | 'dialogue.observe'
  // 12.0 语义漂移防护
  | 'drift.check.request'
  | 'drift.check.result'
  | 'verify.request'
  | 'verify.result'
  // 13.0 灵魂版：Brain 观察队列（OBSERVE 阶段零 LLM 持久化）
  | 'brain.observe'
  // L5: Agent 目录实时查询
  | 'agent.discover'
  | 'agent.discover.reply'
  /** 13.0 §5.3.14: Agent 拒绝任务，建议重路由到其他 Agent */
  | 'task.reject'
  /** 13.0 §5.3.10: Kernel → Agent 目录变更推送（agent register/crashed 触发） */
  | 'directory.changed'
  // 13.0 §13.8/§11.4/§11.7: Brain 子进程 ↔ core 跨进程事件中继（EventBus 是进程内的，
  // brain 作为独立子进程发不到 core，故这四个事件改走 IPC 边界，由 delegation-orchestrator 中继）
  /** core → brain：CronScheduler 发的 cron.review，中继给 Brain 审核 */
  | 'cron.review'
  /** brain → core：Brain 观察到 blocker/question，请求注入软纠偏 */
  | 'brain.signal_intervention'
  /** brain → core：Brain 派发 checker 独立二次审核 */
  | 'brain.checker.dispatch'
  /** brain → core：cron 审核发现问题，前端展示警告 */
  | 'brain.cron_review_flagged';

// === Global registry for kernel-owned singletons (for graceful shutdown + observability) ===
// R14-2：OrphanReconciler 已删除，相关 globalThis 占位声明清理。
// OrphanReconciler 之前是 "启动时 5s 一次性扫 conversations" 的兜底机制，
// 现在被 SessionManager.recoverSessions 替代（在写入点直接写 [系统] 行）。
declare global {
  // 保留 declare global 以供未来新增 kernel-owned 单例挂载
  // eslint-disable-next-line no-var
}
