export type ProgressStatus = 'thinking' | 'using_tool' | 'reviewing' | 'routing' | 'dispatching' | 'asking' | 'streaming' | 'done';

/** 流式进度事件 */
export interface SocketProgressEvent {
  type: 'progress';
  status: ProgressStatus;
  summary: string;
  taskId?: string;
  /** 对话 sessionId，前端用于按对话过滤 WS 消息 */
  sessionId?: string;
}

/** 最终结果事件（已有 sessionId） */
export interface SocketResultEvent {
  type: 'result';
  response: string;
  sessionId: string;
  taskId: string;
}

/** 错误事件 */
export interface SocketErrorEvent {
  type: 'error';
  error: string;
  code?: string;
  /** 对话 sessionId，前端用于按对话过滤 WS 消息 */
  sessionId?: string;
}

export interface PermissionListEvent {
  type: 'permissions.list';
  sessionId?: string;
}

export interface PermissionResolveEvent {
  type: 'permissions.approve' | 'permissions.deny' | 'permissions.cancel';
  requestId: string;
  reason?: string;
  allowSession?: boolean;
}

export interface SocketInterruptEvent {
  type: 'interrupt';
  sessionId: string;
  reason?: string;
}

export interface SocketInterruptedEvent {
  type: 'interrupted';
  sessionId: string;
  taskId?: string;
  partialResponse?: string;
}

/**
 * 13.0 灵魂版：Agent 间对话事件（推送至前端对话面板）。
 *
 * 触发时机：任何 module agent 通过 AgentPort.request() 发起的 dialogue.send / dialogue.reply
 * 都会被 Kernel 通过 EventBus 'agent.dialogue' 事件广播，WsEventBridge 转发为 WS 消息。
 *
 * 设计：与 dialogue.status 互补 — status 关注生命周期（started/round_complete/ended），
 * 本事件关注每条消息内容（让前端能展示 Agent 间真实对话流）。
 */
export interface AgentDialogueEvent {
  type: 'agent_dialogue';
  /** 对话 ID（与 DialogueState.dialogueId 对齐） */
  dialogueId: string;
  /** 发送方 Agent */
  from: string;
  /** 接收方 Agent */
  to: string;
  /** 消息内容 */
  content: string;
  /** 当前轮次（0-based） */
  round: number;
  /** 事件类型：send（发起）/ reply（回复）/ end（结束） */
  phase: 'send' | 'reply' | 'end';
  /** 关联 sessionId，前端用于按 session 过滤 */
  sessionId?: string;
  /** 关联 taskId */
  taskId?: string;
  /** 时间戳（毫秒） */
  timestamp: number;
}

// --- Socket request/response type map ---

export interface AgentsListRequest {
  type: 'agents.list';
  source?: string;
  status?: string;
}

export interface AgentsInspectRequest {
  type: 'agents.inspect';
  name: string;
}

export interface AgentsInstallRequest {
  type: 'agents.install';
  dir: string;
}

export interface AgentsRemoveRequest {
  type: 'agents.remove';
  name: string;
  force?: boolean;
}

export interface AgentsUpgradeRequest {
  type: 'agents.upgrade';
  name: string;
}

export interface AgentsEnableRequest {
  type: 'agents.enable';
  name: string;
}

export interface AgentsDisableRequest {
  type: 'agents.disable';
  name: string;
  reason?: string;
}

export interface AgentsReloadRequest {
  type: 'agents.reload';
}

export type SocketRequestType =
  | 'handshake'
  | 'status'
  | 'health'
  | 'logs.level.get'
  | 'logs.level.set'
  | 'permissions.list'
  | 'permissions.approve'
  | 'permissions.deny'
  | 'permissions.cancel'
  | 'model.override'
  | 'model.get'
  | 'evolution.dispatch'
  | 'message'
  | 'interrupt'
  | 'agents.list'
  | 'agents.inspect'
  | 'agents.install'
  | 'agents.remove'
  | 'agents.upgrade'
  | 'agents.enable'
  | 'agents.disable'
  | 'agents.reload'
  | 'daemon.register'
  | 'daemon.heartbeat'
  | 'daemon.task.claim'
  | 'daemon.task.started'
  | 'daemon.task.progress'
  | 'daemon.task.result'
  | 'daemon.disconnect';
