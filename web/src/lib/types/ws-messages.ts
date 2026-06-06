/**
 * Typed WebSocket message contracts between backend and frontend.
 * Each interface corresponds to a `type` field value from the server.
 *
 * 所有流式消息都携带可选的 sessionId 字段（由后端注入），
 * 前端 onMessage 用它按对话过滤，防止跨对话内容污染。
 */

// ─── Server → Client messages ─────────────────────────────────────

export interface TextDeltaMessage {
  type: "text_delta";
  text: string;
  /** 对话 sessionId，前端按对话过滤用 */
  sessionId?: string;
}

export interface ProgressMessage {
  type: "progress";
  summary?: string;
  pct?: number;
  sessionId?: string;
}

export interface ResultMessage {
  type: "result";
  /** 后端 SocketResultEvent.response 字段 */
  response?: string;
  /** 兼容旧版 content 字段 */
  content?: string;
  sessionId?: string;
}

export interface ErrorMessage {
  type: "error";
  error?: string;
  message?: string;
  sessionId?: string;
}

export interface CancelledMessage {
  type: "cancelled";
  sessionId?: string;
}

export interface InterruptedMessage {
  type: "interrupted";
  sessionId?: string;
}

export interface DelegationNeededMessage {
  type: "delegation.needed";
  delegationId: string;
  sessionId: string;
  requestedBy: string;
  title: string;
  description: string;
  urgency: string;
  options: string[];
}

export interface PermissionConfirmNeededMessage {
  type: "permission.confirm_needed";
  requestId: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  brainReason: string;
}

export interface ToolCallMessage {
  type: "tool_call";
  toolName: string;
  input: string;
  result: string;
  isError: boolean;
  durationMs: number;
  taskId: string;
  sessionId?: string;
}

export interface ReasoningDeltaMessage {
  type: "reasoning_delta";
  text: string;
  sessionId?: string;
}

/** Agent 间对话状态事件（11.0 dialogue 协议，Kernel → 前端） */
export interface DialogueStatusMessage {
  type: "dialogue_status";
  /** 对话 ID */
  dialogueId: string;
  /** 对话阶段：started=开始, round_complete=一轮完成, ended=对话结束 */
  status: "started" | "round_complete" | "ended";
  /** 发起方 Agent 名 */
  from: string;
  /** 目标 Agent 名 */
  to: string;
  /** 当前轮次 */
  round: number;
  /** Conversation 决定暴露的对话概要 */
  summary?: string;
  sessionId?: string;
}

/** Agent 委派/交接事件（Kernel → 前端） */
export interface AgentHandoffMessage {
  type: "agent_handoff";
  from: string;
  to: string;
  intent: string;
  sessionId?: string;
}

/** Agent 向用户提问事件（Kernel → 前端） */
export interface AskUserMessage {
  type: "ask_user";
  question: string;
  options?: string[];
  sessionId: string;
  taskId: string;
}

/** 工具执行结果（独立于 tool_call 的 result 字段）— 流式契约补全 */
export interface ToolResultMessage {
  type: "tool_result";
  toolName: string;
  isError?: boolean;
  durationMs?: number;
  sessionId?: string;
  taskId?: string;
}

/** 模型不确定信号（Kernel → 前端）— agent 自报 confidence 低 */
export interface UncertaintyMessage {
  type: "uncertainty";
  reason: string;
  sessionId?: string;
  taskId?: string;
}

/** 对话无回复（Kernel → 前端）— Brain 路由失败 / Runtime 异常 / 超时 */
export interface NoResponseMessage {
  type: "no_response";
  reason: string;
  sessionId?: string;
  taskId?: string;
}

/** Union of all server → client WebSocket messages */
export type ServerMessage =
  | TextDeltaMessage
  | ProgressMessage
  | ResultMessage
  | ErrorMessage
  | CancelledMessage
  | InterruptedMessage
  | DelegationNeededMessage
  | PermissionConfirmNeededMessage
  | ToolCallMessage
  | ToolResultMessage
  | ReasoningDeltaMessage
  | DialogueStatusMessage
  | AgentHandoffMessage
  | AskUserMessage
  | UncertaintyMessage
  | NoResponseMessage;

// ─── Client → Server messages ─────────────────────────────────────

export interface ClientChatMessage {
  type: "message";
  text: string;
  sessionId: string | null;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>;
}

/** 中断当前生成，sessionId 标识要中断的对话（从消息体取，与 WS clientId 无关） */
export interface ClientInterruptMessage {
  type: "interrupt";
  sessionId: string;
}

export interface ClientDelegationResponseMessage {
  type: "delegation.respond";
  delegationId: string;
  response: string | null;
  status: "approved" | "denied";
}

export interface ClientPermissionResponseMessage {
  type: "permissions.approve" | "permissions.deny";
  requestId: string;
}

/** Union of all client → server WebSocket messages */
export type ClientMessage =
  | ClientChatMessage
  | ClientInterruptMessage
  | ClientDelegationResponseMessage
  | ClientPermissionResponseMessage;
