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

/**
 * 13.0 灵魂版：Brain 审核信息（message.responded 事件）
 * 在 result 事件之后到达，携带 Brain 的审核裁决、理由和原始初稿。
 */
export interface ReviewInfoMessage {
  type: "review_info";
  sessionId: string;
  taskId: string;
  response: string;
  /** Brain 审核裁决：approve=通过, modify=已修改, reject=已拦截 */
  verdict?: "approve" | "modify" | "reject";
  /** Brain 审核理由（modify/reject 时非空） */
  reviewReason?: string;
  /** Brain 修改前的原始初稿（modify/reject 时非空，前端可展示 diff） */
  originalDraft?: string;
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

/**
 * 对话内联 block 事件（设计文档/22）。
 * 后端 stream.block 经 ws-event-bridge 单映射为 ws type 'block'。
 * payload 即 StreamBlockPayload（见 lib/blocks.ts）：携带 messageId/blockId/blockType，
 * text/thinking 走 delta，tool/delegation 走完整 block。前端 applyBlock 据此内联渲染。
 */
export interface BlockMessage {
  type: "block";
  sessionId?: string;
  messageId: string;
  blockId: string;
  blockType: "text" | "thinking" | "tool" | "delegation" | "review" | "orchestration" | "task_progress";
  block?: unknown;
  state?: string;
  delta?: string;
  ts: number;
  taskId?: string;
  correlationId?: string;
}

/**
 * 16.0 P5-C2：任务板新信封落板事件（board.message.posted → ws.type='board.message'）。
 *
 * 后端 board-projection.safePost 在信封落板成功后 emit 'board.message.posted'，
 * WsEventBridge 经 STREAM_EVENT_MAPPING 平铺转发为 ws.type='board.message'，
 * 前端看板 UI（§14.5 任务进展卡）据此实时刷新。当前为最小消费（仅 debug log 证明链路通）。
 *
 * 字段语义（与后端 EventMap['board.message.posted'] 完全一致）：
 *   - taskId：板 id（= delegationId，板与 delegation 1:1）
 *   - sessionId：关联会话 id（前端按对话过滤用）
 *   - messageType：信封类型（前端可据此决定 UI 优先级，如 command 高亮、report 更新徽章）
 *   - messageId：板上信封 id（去重 / 定位用）
 *   - from / to：信封收发方（看板气泡渲染用）
 */
export interface BoardMessageEvent {
  type: "board.message";
  /** 板 id（= delegationId） */
  taskId: string;
  /** 关联会话 id（前端按对话过滤） */
  sessionId?: string;
  /** 信封类型 */
  messageType: "delegate" | "report" | "ask" | "tool_request" | "tool_result" | "command" | "tell";
  /** 板上信封 id（去重 / 定位） */
  messageId?: string;
  /** 发送方 Agent / role 名 */
  from?: string;
  /** 接收方 Agent / role 名 */
  to?: string;
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
  | NoResponseMessage
  | ReviewInfoMessage
  | BlockMessage
  | BoardMessageEvent;

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
