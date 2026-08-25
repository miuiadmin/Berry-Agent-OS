/**
 * L1 session — durable 事件类型：核心词汇 data 载荷类型 + 注册表再导出。
 *
 * 2026-08-25 Hermes 探针 #19 收口（会话篇 §2.1 落码注记）：注册表与
 * SessionEventTypeDefinition 单一来源已迁 contracts/session-events.ts
 * （berryagent 虚拟面随之可取——第三方经 ctx.registerSessionEventType 注册
 * 自有词汇）。本文件保留：
 * - 核心事件词汇的 data 载荷接口（session 模块内部消费面：session/derive/
 *   recover 与 persist/chat 的载荷引用——载荷形状是会话模块的知识，不迁）；
 * - 注册表函数与类型的再导出（session/index.ts 及既有消费面零改动——
 *   check-events.mjs 对本文件的 jiti 导入路径不变）。
 */

export {
  registerSessionEventType,
  registerPluginSessionEventType,
  getSessionEventType,
  listSessionEventTypes,
  isCoreSessionEventType,
  CORE_EVENT_TYPES,
} from '../contracts/session-events.js';
export type { SessionEventTypeDefinition, SessionEventCategory } from '../contracts/session-events.js';

import type { MessageSource } from '../contracts/llm.js';

/** turn/end 终态枚举（三套终态枚举的会话层之锚） */
export type TurnEndReason = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted';

/** user/message 载荷：content 为纯文本或内容块数组（块结构随 llm 模块收口） */
export interface UserMessageData {
  readonly content: unknown;
  /** 归因（会话篇 §3.1 五值词汇；缺省不落字段——读侧视为 'user'） */
  readonly source?: MessageSource;
}

/** assistant/message 载荷：模型响应最终态（usage 为 turn 汇总额，token delta 不落日志） */
export interface AssistantMessageData {
  readonly content: unknown;
  readonly usage?: unknown;
  readonly stopReason?: string;
  readonly interrupted?: boolean;
}

/** tool/call 载荷：arguments 为原始未解析字符串（解析失败留给工具管道处理） */
export interface ToolCallData {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
}

/** tool/result 载荷：error 携带错误码（durable 事件内一律写码不写本地化文案） */
export interface ToolResultData {
  readonly toolCallId: string;
  readonly content: unknown;
  readonly error?: { readonly code: string; readonly message?: string };
  readonly meta?: unknown;
}

/** todo/write 载荷：items 为当前全量快照（非增量 diff） */
export interface TodoWriteData {
  readonly items: readonly unknown[];
}

/** request/header 载荷：组装参数快照（证据腿——请求组装变化才落新快照） */
export interface RequestHeaderData {
  readonly config: unknown;
  readonly systemPrompt: string;
  readonly toolSchemas: readonly unknown[];
  readonly reason: 'initial' | 'resume' | 'change';
  /**
   * 会话应用域标记（契约篇 §5.4 第二纵切——与 sessions.app 同源的载荷腿：
   * 血缘显式打标的证据腿，读侧投影不依赖 sessions 行也能从事件流看出归属）。
   * NULL 域（存量会话/未打标）不落字段。
   */
  readonly app?: string;
}

/** 审批请求载荷（log-only：落日志即目的） */
export interface ApprovalAskedData {
  readonly approvalId: string;
  readonly summary: string;
}

/** 审批决议载荷（log-only；decision 四值与 ApprovalService outcome 闭集对齐——cancelled/unavailable 也是已完成的决策，审计须区分） */
export interface ApprovalDecidedData {
  readonly approvalId: string;
  readonly decision: 'approve' | 'reject' | 'cancel' | 'unavailable';
}

/** 守门决议载荷（log-only；不变式：任何 tool/result 前序必含对应 toolCallId 的 gate/decision） */
export interface GateDecisionData {
  readonly toolCallId: string;
  readonly decision: 'allow' | 'block' | 'mutate';
  readonly reason: string;
}

/** 沙箱模式载荷（log-only，fold） */
export interface SandboxModeData {
  readonly mode: string;
}

/**
 * llm/usage 载荷（log-only，2026-08-24 第十一批拍板 #1——会话篇 §1.1）：
 * ctx.llm.complete 单发补全通道的计量事实。底账 durable 化——花销是事件流事实、
 * 余额（canAfford）是投影查询不存储；callId = settlement 幂等身份（write-behind
 * 重试去重锚点）。token 原始值入账，货币折算在投影做（价格表更新不回改历史）。
 */
export interface LlmUsageData {
  /** 本次补全的结算 id（每次 complete 调用唯一——randomUUID） */
  readonly callId: string;
  /** 模型标识（"provider/model-id"） */
  readonly model: string;
  /** 预算道：'background' 接闸门（当日聚合只计 background） */
  readonly priority: 'background' | 'foreground';
  /** 原始用量（in/out token 数——聚合 SUM(input+output)） */
  readonly usage: { readonly input: number; readonly output: number };
}
