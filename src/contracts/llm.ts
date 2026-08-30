/**
 * L0 contracts — LLM 边界消息基础件（骨架篇 §5.4：形状直接对齐 pi-ai）。
 *
 * 地基篇 §4.2 的关键决策：pi 的 agent 包实际依赖 pi-ai 基础件（消息形状 / 流事件 /
 * 参数校验）；berry 把这些基础件收进 contracts，agent 模块据此做到对 llm 零 import。
 *
 * 兼容策略：字段取 pi-ai 对应接口的**超集兼容子集**——本文件要求的必填字段在
 * pi-ai 中全部存在且同名同型，因此 pi-ai 产生的消息值可原样赋给这里的类型
 * （标准角色零转换直通，骨架篇 §5.4）；pi-ai 独有的字段（api/responseModel 等）
 * 不在此收口，多出的字段对结构化赋值透明。
 */

/* ---------------- 内容块（assistant 内联 / user 附件） ---------------- */

/** 文本块（user/assistant/toolResult 通用） */
export interface TextContent {
  type: 'text';
  text: string;
  /** 供应商侧文本签名（OpenAI responses 元数据回放用；透传） */
  textSignature?: string;
}

/** 思考块（仅 assistant；供应商推理内容回放） */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /** 供应商不透明签名（推理上下文复用；透传） */
  thinkingSignature?: string;
  /** 安全过滤已遮蔽的思考（加密载荷存 thinkingSignature 透传回 API） */
  redacted?: boolean;
}

/** 图片块（多模态附件；base64 数据） */
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 工具调用块（仅 assistant 内联；arguments 已是解析后的对象） */
export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/* ---------------- 用量与终态 ---------------- */

/** 一次 LLM 调用的 token 用量（骨架篇 L7：usage 拆 cacheRead/cacheWrite/cacheWrite1h/reasoning） */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheWrite 中 1h 保留的子集（仅 Anthropic 上报拆分） */
  cacheWrite1h?: number;
  /** 推理 token 子集（已含于 output；供应商不报则缺省） */
  reasoning?: number;
  totalTokens: number;
  /** 费用（供应商可解析时填充） */
  cost?: { total: number; input?: number; output?: number; currency?: string };
}

/**
 * LLM 调用终态（pi-ai 同构七值）。
 * loop 只消费 error/aborted（终态短路）与 length（截断防御，骨架篇 §2.4）；
 * deferred 是 pi-ai 原生延迟工具装载透传值，v1 不产生但词汇保留。
 */
export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';

/* ---------------- 三角色消息 ---------------- */

/**
 * user 消息归因词汇（会话篇 §3.1 dsh-8 定稿，五值 + v2 预留）：
 * 谁把这条消息放进历史——真人输入 / 通道转发 / 应用注入 / 定时投递 / 子代理结算回投。
 * 前缀型模板串承载 id/name（如 `channel:telegram`、`app:memory`）。
 */
export type MessageSource = 'user' | 'schedule' | 'subagent-settled' | `channel:${string}` | `app:${string}`;

/** 用户消息（content 允许纯文本或图文块数组） */
export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /**
   * 归因（可选，缺省视为 'user'——pi-ai 值不带此字段即真人/常规输入面）：
   * 注入方（通道/应用/调度/子代理结算）显式声明，durable 原样落账、投影带出。
   */
  source?: MessageSource;
  /**
   * 归因键值对（可选，骨架篇 §6.8 刀三 T7-A 轮身份）：source 之外的机器可读
   * 归因（如 goal 续跑轮的 goalId/wakeId/wakePath）——通用键值面非 goal 专属
   * 词面（「source + app 键值对」）。durable 原样落账、投影/回读还原——帽投影
   * （wakeGate）扫描的就是这面，非消息正文。
   */
  attribution?: Readonly<Record<string, string>>;
}

/** 助手消息（流式组装终值；stopReason=error/aborted 时错误即数据，见 AssistantStream） */
export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCallBlock)[];
  usage: Usage;
  stopReason: StopReason;
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /** 模型标识（provider 内模型 id；llm 模块解析） */
  model?: string;
  /** 供应商标识 */
  provider?: string;
  /** stopReason=error/aborted 时的错误说明（错误三件套之二） */
  errorMessage?: string;
  /**
   * 错误码（错误三件套之四——S4 提前兑现，骨架篇 §3.4）：宿主合成错误携带
   * LLM_ 码（如 LLM_INFLIGHT_LIMIT 帽拒绝）；provider 真错误码归一挂 M2
   * （pi-ai 错误对象→码）。桶表（llm/recovery）判定时在场码优先、文案兜底——
   * 摆脱 [CODE] 文本前缀约定的机器判定位。
   */
  errorCode?: string;
  /** 脱敏诊断（错误三件套之三；恢复与审计用） */
  diagnostics?: unknown[];
}

/** 工具结果消息（与 assistant 内 toolCall 按 toolCallId 配对） */
export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /** 供日志/UI 的结构化明细（不进主上下文计费） */
  details?: unknown;
  /** 工具执行自身的用量（若可得上报；不进主上下文计费） */
  usage?: Usage;
  /** 本次结果后新可用的工具名（延迟装载透传） */
  addedToolNames?: string[];
}

/** LLM 边界标准三角色（骨架篇 §2.3：AgentMessage 的标准半边，convertToLlm 透传） */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/* ---------------- 请求上下文与工具描述 ---------------- */

/** LLM 工具描述（parameters 为 JSON Schema——TypeBox 产物即此形状，契约篇 §3.1） */
export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema 参数描述（TypeBox 产物或等价 JSON Schema 对象；宽收 object 兼容 TypeBox 构建器类型） */
  parameters: object;
}

/** 单次 LLM 请求上下文（StreamFn 第一参数；骨架篇 §3.1） */
export interface LlmContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: LlmTool[];
}

/* ---------------- 模型层调用接缝（agent 与 llm 在此会合） ---------------- */

/**
 * 模型目录只读投影（ctx.llm.listModels()/getModel() 返回形——2026-08-26 挖矿批
 * P0-1，骨架篇 §9.3）：pi-ai Model 的应用友好子集——枚举/展示/能力判别所需字段
 * 直通，传输与 provider 配置面（baseUrl/headers/samplingParams/compat）不披露
 * （宿主数据只经 ctx 服务面，契约篇 §1.5——provider 应用要的是「有哪些模型」
 * 而非「怎么连到它们」）。
 */
export interface ModelInfo {
  /** 模型标识（"provider/model-id" 全形——resolveModel 可解析的同一名） */
  readonly id: string;
  /** 展示名（人类可读） */
  readonly name: string;
  /** 所属 provider id（目录分组用） */
  readonly provider: string;
  /** 是否推理模型（思考档位面可用性判据） */
  readonly reasoning: boolean;
  /** 输入模态清单 */
  readonly input: readonly ('text' | 'image')[];
  /** 上下文窗口（tokens） */
  readonly contextWindow: number;
  /** 单请求输出上限（tokens） */
  readonly maxTokens: number;
}

/** 思考档位（pi-ai 同构七值；xhigh/max 仅部分模型家族支持） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** StreamFn 每次调用的选项（model 为模型 id 字符串——解析归 llm 模块，loop 不持模型对象） */
export interface StreamFnOptions {
  /** 模型 id（llm 模块解析为具体 provider/model；prepareNextTurn 可逐轮替换） */
  model: string;
  thinkingLevel?: ThinkingLevel;
  /** 凭证（getApiKey 回调解析所得；缺省 undefined 由 llm 层走持久化凭证） */
  apiKey?: string;
}

/**
 * 模型层注入签名（llm 模块整体替换位——agent 与 llm 两模块的唯一会合点，故落在
 * contracts）。契约：**永不抛错**——一切失败编码为返回流的 error 终止事件 + 最终消息
 * stopReason='error'|'aborted' + errorMessage + diagnostics（AssistantStream 契约注释）。
 * 这是 loop 零 try/catch 的契约根基：错误是数据不是异常（骨架篇 §3.1）。
 */
export type StreamFn = (
  context: LlmContext,
  options: StreamFnOptions,
  signal?: AbortSignal,
) => AssistantStream | Promise<AssistantStream>;

/* ---------------- 流式事件协议（AssistantStream） ---------------- */

/**
 * 流式事件（pi-ai AssistantMessageEvent 同构 12 型）。
 * 协议：`start` 先行 → 各内容块 start/delta/end 交错（partial 携带累计快照）→
 * 以 `done`（成功）或 `error`（stopReason=error/aborted）收尾。
 */
export type AssistantStreamEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallBlock; partial: AssistantMessage }
  | {
      type: 'done';
      reason: Extract<StopReason, 'stop' | 'length' | 'toolUse' | 'deferred'>;
      message: AssistantMessage;
    }
  | { type: 'error'; reason: Extract<StopReason, 'aborted' | 'error'>; error: AssistantMessage };

/**
 * 流式响应：异步迭代事件 + 最终消息取值口。
 * 契约（骨架篇 §3.1，loop 零 try/catch 的根基）：**永不抛错**——一切失败编码为
 * 流内 `error` 终止事件 + 最终 AssistantMessage 的 stopReason='error'|'aborted' +
 * errorMessage + diagnostics。错误是数据不是异常。
 */
export interface AssistantStream {
  /** 迭代流事件（以 done/error 收尾后结束） */
  [Symbol.asyncIterator](): AsyncIterator<AssistantStreamEvent>;
  /** 取最终 AssistantMessage（流耗尽后 resolve；失败编码在 stopReason/errorMessage 上） */
  result(): Promise<AssistantMessage>;
}
