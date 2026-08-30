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

/* ------------------------------------------------------------------ */
/* 刀三：审批应答面 + @-mention 补全 + checkpoint 转录行（窄类型拷贝） */
/* ------------------------------------------------------------------ */

/** web 应答闭集（锚 WebuiApprovalDecision——cancel 无 web 产出面） */
export type ApprovalDecision = 'approve' | 'reject' | 'always';

/**
 * 未决审批条目（锚 WebuiPendingApproval）。两消费面：GET /api/approvals
 * 恢复面 + SSE approval/asked 帧驱动（角标 + inline 卡数据源）。
 */
export interface PendingApproval {
  /** 审批 id（卡片键） */
  readonly approvalId: string;
  /** 归属会话（asked 镜像信封 sessionId；根路审批缺省 undefined 档） */
  readonly sessionId?: string;
  /** 目标动作摘要 */
  readonly summary: string;
  /** 请求方/理由 */
  readonly reason?: string;
  /** 「始终允许」草案（在场 = 三态按钮） */
  readonly suggestedEntry?: { readonly tool: string; readonly pattern: string };
  /** 归属标签（appId 在场时卡面披露） */
  readonly ownership?: { readonly appId?: string; readonly sessionId: string };
  /** 出队优先级（'background' 时卡面注记） */
  readonly priority?: string;
}

/** 工作区符号补全条目（锚 WebuiSymbolItem——LSP documentSymbol 投影） */
export interface SymbolItem {
  /** 符号名（插入锚） */
  readonly name: string;
  /** 定义行号（1-based；协议缺失时省） */
  readonly line?: number;
  /** LSP SymbolKind 数值（前端不做词表翻译，仅展示） */
  readonly kind?: number;
}

/** 符号查询应答（锚 WebuiSymbolQuery——warming = 服务器预热中） */
export interface SymbolQuery {
  readonly symbols: readonly SymbolItem[];
  readonly warming?: boolean;
}

/** checkpoint/rewind 转录行（SSE session 镜像帧载荷——surface 词不进投影，仅活体呈现） */
export interface RewindRow {
  /** 归属（旧）会话 */
  readonly sessionId: string;
  /** 回退到的快照 id */
  readonly id: string;
  /** fork 出的新会话 id */
  readonly newSessionId: string;
  /** 恢复文件数 */
  readonly files: number;
}
