/**
 * SPA 侧线格式窄类型——服务面契约的结构子集拷贝（锚 src/webui/types.ts 与
 * src/session/derive.ts、src/agent/events.ts、src/chat/todo.ts）。
 *
 * 判别键逐字对齐宿主真身；未知字段透传忽略——服务面升版时前端「只增不改」
 * 即兼容。独立成文件不复用宿主类型：client 子树被根 tsconfig 排除（vite
 * 打包域），import 宿主模块会拖入 Node 域类型（拓扑门禁同族排除的原因）。
 */

/** 会话清单条目（GET /api/sessions 响应元素——锚 WebuiSessionSummary） */
export interface SessionSummary {
  /** 会话 id */
  readonly id: string;
  /** 应用域键（coder / chat / 第三方应用 id） */
  readonly appId: string;
  /** 工作目录（sessions 行直出；store 行迟到时可缺省） */
  readonly cwd?: string;
  /** 创建时刻（epoch 毫秒） */
  readonly createdAt?: number;
  /** 最近事件时刻（epoch 毫秒） */
  readonly updatedAt?: number;
  /** 是否活会话（可 submit；false = 已闭只读） */
  readonly active: boolean;
  /** 应用强调色（清单 theme.accent 内嵌——缺席走前端缺省色） */
  readonly accent?: string;
}

/** todo 条目（GET /api/sessions/:id/todo 的 todo 数组元素——锚 WebuiTodoItem / chat 件 TodoItem） */
export interface TodoItem {
  /** 条目内容（祈使句短语） */
  readonly content: string;
  /** 状态三值：pending / in_progress / completed */
  readonly status: string;
  /** 进行中条目的现在进行时描述（渲染优先于 content） */
  readonly activeForm?: string;
}

/** 投影工具调用块（挂在 assistant 消息上——锚 ProjectedToolCall） */
export interface ProjectedToolCall {
  readonly type: 'toolCall';
  readonly toolCallId: string;
  readonly toolName: string;
  /** 参数 JSON 串（schema 守门后原文） */
  readonly arguments: string;
}

/**
 * 消息投影三型判别联合（锚 ProjectedMessage）。content 是块数组（pi-ai
 * AgentMessage 形态）——文本提取见 app 侧 textOf，非文本块不渲染。
 */
export type ProjectedMessage =
  | { readonly type: 'user'; readonly seq: number; readonly content: unknown; readonly source?: string }
  | {
      readonly type: 'assistant';
      readonly seq: number;
      readonly content: unknown;
      readonly toolCalls: readonly ProjectedToolCall[];
      readonly usage?: unknown;
      readonly stopReason?: string;
    }
  | {
      readonly type: 'toolResult';
      readonly seq: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: string;
      readonly output: unknown;
      readonly isError: boolean;
    };

/** display 族消息面窄形状（content 块数组——文本块之外的块忽略） */
interface DisplayMessage {
  readonly content?: unknown;
}

/**
 * display 族活体事件（锚 AgentEvent 十型——只窄 SPA 消费的五型 + agent_start
 * 复位信号，判别键外字段透传）。message_update.message 是**累积快照**（partial
 * 就地替换后整发，非 token delta——渲染侧整体替换，CR-13）。
 */
export type DisplayEvent =
  | { readonly type: 'agent_start' }
  | { readonly type: 'message_update'; readonly message: DisplayMessage }
  | { readonly type: 'message_end'; readonly message: DisplayMessage }
  | {
      readonly type: 'tool_execution_start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | { readonly type: 'tool_execution_update'; readonly toolCallId: string; readonly toolName: string }
  | {
      readonly type: 'tool_execution_end';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    };

/** SSE 信封（锚 WebuiSseEnvelope——session 族 payload = SessionEvent 本体，display 族 = AgentEvent 本体） */
export interface SseEnvelope {
  readonly kind: 'session' | 'display' | 'notify' | 'status';
  readonly sessionId?: string;
  readonly payload: unknown;
}
