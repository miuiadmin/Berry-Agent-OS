/**
 * L1 session — durable 事件类型注册表（会话篇 §1.1 核心事件词汇）。
 *
 * 与错误码同纪律（内核篇 §5.3）：词汇显式注册、运行时可枚举、CI 可校验。
 * 核心清单之外，插件可经 registerSessionEventType 显式注册扩展类型——
 * 未知类型且非 ignorable，读侧整体拒绝（SESSION_FORMAT_UNSUPPORTED）。
 */

import { AppError } from '../contracts/errors.js';

/** 事件类别三分法（会话篇 §1.1）：决定事件在投影/存储分层中的处理方式 */
export type SessionEventCategory =
  /** 表面事件：构成派生表面（模型历史投影输入）——user/message、assistant/message、tool/call、tool/result、todo/write */
  | 'surface'
  /** 快照事件：组装参数变化时整体重写（request/header） */
  | 'snapshot'
  /** log-only：落日志即目的（不进表面推导）——approval/*、gate/decision、sandbox/mode，以及 turn 边界与种子标记等结构事件 */
  | 'log-only';

/** 事件类型注册项 */
export interface SessionEventTypeDefinition {
  /** 事件类型词汇，小写斜线式 `<域>/<动作>` */
  readonly type: string;
  /** 类别三分法归属 */
  readonly category: SessionEventCategory;
  /** true = 读侧可以不认识此类型（向前兼容）；缺省 false = 未知即整体拒绝 */
  readonly ignorable?: boolean;
}

/** 类型词汇格式：小写字母/数字/连字符段，至少一个斜线分隔（`<域>/<动作>`） */
const TYPE_FORMAT = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;

/** 已注册事件类型表（type → 定义） */
const registry = new Map<string, SessionEventTypeDefinition>();

/**
 * 注册一个事件类型（插件扩展入口；核心清单在下方模块加载时已全量注册）。
 * 重复注册或格式非法直接抛错——事件词汇必须在装配期钉死，不留运行时漂移。
 */
export function registerSessionEventType(def: SessionEventTypeDefinition): void {
  if (!TYPE_FORMAT.test(def.type)) {
    throw new AppError('SESSION_FORMAT_UNSUPPORTED', `事件类型格式非法：${def.type}（应为小写斜线式 <域>/<动作>）`);
  }
  if (registry.has(def.type)) {
    throw new AppError('SESSION_FORMAT_UNSUPPORTED', `事件类型重复注册：${def.type}`);
  }
  registry.set(def.type, def);
}

/** 查询类型定义；未注册返回 undefined（调用方按 ignorable 语义决定拒绝与否） */
export function getSessionEventType(type: string): SessionEventTypeDefinition | undefined {
  return registry.get(type);
}

/** 枚举全部已注册事件类型（CI 校验 / 诊断输出用） */
export function listSessionEventTypes(): SessionEventTypeDefinition[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type));
}

/* ------------------------------------------------------------------ */
/* 核心事件词汇 data 载荷类型（字段出处：会话篇 §1.1）                  */
/* ------------------------------------------------------------------ */

/** turn/end 终态枚举（三套终态枚举的会话层之锚） */
export type TurnEndReason = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted';

/** user/message 载荷：content 为纯文本或内容块数组（块结构随 llm 模块收口） */
export interface UserMessageData {
  readonly content: unknown;
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
}

/** 审批请求载荷（log-only：落日志即目的） */
export interface ApprovalAskedData {
  readonly approvalId: string;
  readonly summary: string;
}

/** 审批决议载荷（log-only） */
export interface ApprovalDecidedData {
  readonly approvalId: string;
  readonly decision: 'approve' | 'reject';
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

/* ------------------------------------------------------------------ */
/* 核心清单（首批 13 类，模块加载时注册）                                */
/* ------------------------------------------------------------------ */

/**
 * 核心事件类型词汇。类别归属依据会话篇 §1.1 三分法；turn/start、turn/end、
 * session/end-seed 属结构标记（不进表面推导），归 log-only。
 */
export const CORE_EVENT_TYPES: readonly SessionEventTypeDefinition[] = [
  { type: 'turn/start', category: 'log-only' },
  { type: 'turn/end', category: 'log-only' },
  { type: 'user/message', category: 'surface' },
  { type: 'assistant/message', category: 'surface' },
  { type: 'tool/call', category: 'surface' },
  { type: 'tool/result', category: 'surface' },
  { type: 'todo/write', category: 'surface' },
  { type: 'request/header', category: 'snapshot' },
  { type: 'session/end-seed', category: 'log-only' },
  { type: 'approval/asked', category: 'log-only' },
  { type: 'approval/decided', category: 'log-only' },
  { type: 'gate/decision', category: 'log-only' },
  { type: 'sandbox/mode', category: 'log-only' },
];

for (const def of CORE_EVENT_TYPES) {
  registerSessionEventType(def);
}
