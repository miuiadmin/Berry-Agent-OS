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
  | 'bus.capabilities.response';
