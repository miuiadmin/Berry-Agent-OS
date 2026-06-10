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
  | 'agent.discover.reply';

// === Global registry for kernel-owned singletons (for graceful shutdown + observability) ===
// R14-2：OrphanReconciler 已删除，相关 globalThis 占位声明清理。
// OrphanReconciler 之前是 "启动时 5s 一次性扫 conversations" 的兜底机制，
// 现在被 SessionManager.recoverSessions 替代（在写入点直接写 [系统] 行）。
declare global {
  // 保留 declare global 以供未来新增 kernel-owned 单例挂载
  // eslint-disable-next-line no-var
}
