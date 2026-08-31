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
  registerAppSessionEventType,
  getSessionEventType,
  listSessionEventTypes,
  isCoreSessionEventType,
  CORE_EVENT_TYPES,
} from '../contracts/session-events.js';
export type { SessionEventTypeDefinition, SessionEventCategory } from '../contracts/session-events.js';

import type { MessageSource, Usage } from '../contracts/llm.js';

/** turn/end 终态枚举（三套终态枚举的会话层之锚） */
export type TurnEndReason = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted';

/** user/message 载荷：content 为纯文本或内容块数组（块结构随 llm 模块收口） */
export interface UserMessageData {
  readonly content: unknown;
  /** 归因（会话篇 §3.1 五值词汇；缺省不落字段——读侧视为 'user'） */
  readonly source?: MessageSource;
  /** 归因键值对（骨架篇 §6.8 刀三轮身份——source 之外的机器可读归因，原样落账） */
  readonly attribution?: Readonly<Record<string, string>>;
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

/** 审批决议载荷（log-only；decision 五值与应答闭集 + unavailable 对齐——2026-08-27 扩 'always'：授权常驻写 allowlist 条目，与 approve「批一次」审计语义不同；cancelled/unavailable 也是已完成的决策，审计须区分） */
export interface ApprovalDecidedData {
  readonly approvalId: string;
  readonly decision: 'approve' | 'reject' | 'cancel' | 'unavailable' | 'always';
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
  /** 模型标识（"provider/model-id"）——实录优先：响应携带的模型优先，请求标识兜底，'unknown' 兜底（两路写点同律） */
  readonly model: string;
  /** 预算道：'background' 接闸门（当日聚合只计 background） */
  readonly priority: 'background' | 'foreground';
  /**
   * 原始用量全桶（2026-08-27 P1-5 底账扩桶修偏，会话篇 §1.1——三写点曾同裁
   * 两桶丢 cacheRead/cacheWrite）：四桶必落（pi-ai Usage 四必填）；cacheWrite1h/
   * reasoning 供应商上报才落；totalTokens（派生）与 cost（折算）不入账——
   * 派生与折算归投影（「token 原始值入账，货币折算在投影做」律的执行修偏）。
   */
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    /** cacheWrite 中 1h 保留的子集（仅 Anthropic 上报拆分——缺省省略字段） */
    readonly cacheWrite1h?: number;
    /** 推理 token 子集（已含于 output；供应商不报则缺省省略字段） */
    readonly reasoning?: number;
  };
}

/* ---- llm/usage callId 判别式三函数（2026-09-01 复盘 R-1 同源收口） ----
 * 三写点各携可判别的 callId 前缀：前台 loop 腿 'turn:'、委派结算折叠腿
 * 'delegation:'、complete 单发腿无前缀（randomUUID 裸形）。构造与判别收口
 * 于本模块（载荷类型旁）= 写点与读点单源：goal ④ 预算腿按前缀消费委派折叠
 * 笔（运行时骨架篇 §6.8「预算刹车」例外二），前缀散落字符串比对即判别式漂移。
 */

/** 前台 loop 写点 callId 前缀（`${sessionId}:${seq}` 拼在前缀后） */
const TURN_USAGE_CALLID_PREFIX = 'turn:';

/** 委派结算折叠写点 callId 前缀（executionId 拼在前缀后） */
const DELEGATION_USAGE_CALLID_PREFIX = 'delegation:';

/**
 * 前台 loop 写点 callId 构造（chat/durable.ts 前台腿）：`turn:<sessionId>:<seq>`。
 * @param sessionId 会话 id
 * @param seq 该笔 usage 锚定的 durable 事件序号
 */
export function turnUsageCallId(sessionId: string, seq: number): string {
  return `${TURN_USAGE_CALLID_PREFIX}${sessionId}:${seq}`;
}

/**
 * 委派结算折叠写点 callId 构造（app/notify.ts 折叠腿）：`delegation:<executionId>`。
 * 前缀为常量——write-behind 去重锚语义不损（executionId 仍唯一）。
 * @param executionId 子运行执行 id（in-process = 子会话 id）
 */
export function delegationUsageCallId(executionId: string): string {
  return `${DELEGATION_USAGE_CALLID_PREFIX}${executionId}`;
}

/**
 * 委派结算折叠笔判别式（goal/app.ts ④ 预算腿消费面）：只认前缀不认 priority
 * ——complete 单发腿 randomUUID 裸形不命中（不与轮间沉淀自报双计）、前台
 * 'turn:' 笔不命中（已随 assistant/message 主腿计过，再计即双计）。
 * @param callId llm/usage 载荷的 callId
 */
export function isDelegationUsageCallId(callId: string): boolean {
  return callId.startsWith(DELEGATION_USAGE_CALLID_PREFIX);
}

/**
 * llm/usage 底账桶归一（会话篇 §1.1 全桶入账）：从 llm 层 Usage 原始对象
 * 提取事件载荷形状——四必填桶直拷，两可选桶（cacheWrite1h/reasoning）上报才
 * 落字段，totalTokens/cost 滤除（派生与折算归投影）。三处写点（schema 定义
 * 侧 / complete 单发写点 / 前台 loop 写点）共用本函数 = 裁桶不可能再发生的
 * 单一事实源——修偏前两写点各自手写 `{input,output}` 正是挖矿 B3 抓的病灶。
 *
 * @param usage llm 层一次调用的原始用量（pi-ai 同构 Usage）
 * @returns llm/usage 事件 data.usage 字段的归一形状
 */
export function usageLedgerBuckets(usage: Usage): LlmUsageData['usage'] {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
  };
}

/**
 * llm/usage 底账 model 归一（会话篇 §1.1——"provider/model-id" 全形实录优先）：
 * 响应消息自带 provider+model 时拼全形（实录）；只带 model 落半形；两者皆缺走
 * 请求兜底标识；再缺 'unknown'。两路写点（complete 单发/前台 loop）共用本函数
 * = model 口径单一事实源——修偏前 complete 写请求标识、loop 写裸 model id，
 * 同一底账两种口径（挖矿即刻批②观察项，P1-5 收编）。
 *
 * @param message 响应终值消息（provider/model 均为可选元数据腿）
 * @param fallback 请求侧模型标识兜底（装配缺省/会话模型，"provider/model-id" 全形）
 * @returns llm/usage 事件 data.model 字段的归一值
 */
export function ledgerModel(
  message: { readonly model?: string; readonly provider?: string },
  fallback?: string,
): string {
  if (message.provider !== undefined && message.model !== undefined) {
    return `${message.provider}/${message.model}`;
  }
  return message.model ?? fallback ?? 'unknown';
}

/**
 * llm/retry 载荷（log-only，S4 前置债批 2026-08-26——会话篇 §1.1）：会话层
 * turn 级 auto-retry 的 durable 事实（「只在 debug 出现的分支其行为必须同时是
 * durable 事件」红线在恢复路径的执法）。**遮蔽随本事件信封携带**：scheduled
 * 次的 append 可带 surfaceOp（信封级字段任何类型可携带，derive occludedSeqs
 * 按字段扫）——一次 append 同时完成落账与错误 assistant 单点遮蔽（会话篇 §2
 * 第二消费者）。写入者 = 驱动 runTurns 重试循环（chat 件——前缀 llm/ 表语义域
 * 非模块属地，核心词宿主注册）。
 */
export interface LlmRetryData {
  /** 本轮第几次重试（1 起——第 0 次是原始失败本身，不落本词） */
  readonly attempt: number;
  /** 重试帽（RetryPolicy.maxRetries） */
  readonly maxAttempts: number;
  /** 抖动后实延迟（毫秒——审计可辨多驱动共振打散效果） */
  readonly delayMs: number;
  /** 生命周期相位：scheduled=退避排定（本条可携遮蔽）/ aborted=退避中被取消 / exhausted=达帽放弃 */
  readonly phase: 'scheduled' | 'aborted' | 'exhausted';
  /** 触发重试的错误说明（exhausted 随行末次错误；scheduled 也携带供审计） */
  readonly errorMessage?: string;
  /**
   * 恢复类属（第四十五批溢出兜底）：transient = 退避重试腿（S4 既有）；
   * overflow = 溢出兜底腿（compact-and-retry-once，自有名额 attempt=1/
   * maxAttempts=1）。缺省 transient——旧日志无字段读侧视为 transient。
   */
  readonly reason?: 'transient' | 'overflow';
}
