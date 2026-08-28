/**
 * L1 llm — 会话层恢复零件的 berry 类型面包装（骨架篇 §5.1 L5：现成零件直接复用）。
 *
 * pi-ai 的 isContextOverflow / retryAssistantCall 等零件面向 pi-ai AssistantMessage
 * 类型签名；本文件以**我们的 contracts AssistantMessage** 为签名薄包装（结构同构，
 * 边界单次收口），app 装配层（会话层 turn 级 auto-retry 与溢出 compact-and-retry-once，
 * 骨架篇 §3.2 下两行）从这里取用，不直接触 pi-ai 类型。
 */

import {
  isContextOverflow as piIsContextOverflow,
  isRecoverableLength as piIsRecoverableLength,
  isRetryableAssistantError as piIsRetryable,
  retryAssistantCall as piRetryAssistantCall,
} from '@earendil-works/pi-ai';
import type {
  AssistantMessage as PiAssistantMessage,
  RetryCallbacks as PiRetryCallbacks,
  RetryPolicy as PiRetryPolicy,
} from '@earendil-works/pi-ai';
import type { AssistantMessage } from '../contracts/llm.js';

/** 重试策略（指数退避 baseDelayMs * 2^(attempt-1)；pi-ai 同构透传） */
export type RetryPolicy = PiRetryPolicy;
/** 重试过程回调（UI 事件挂点：调度前/开始前/结束时；pi-ai 同构透传） */
export type RetryCallbacks = PiRetryCallbacks;

/** 边界收口：berry 消息 → pi-ai 签名（结构同构，超集兼容子集方向） */
function toPi(message: AssistantMessage): PiAssistantMessage {
  return message as unknown as PiAssistantMessage;
}

/**
 * 检测上下文溢出（骨架篇 §3.2 会话层溢出兜底的第一步）。
 * 覆盖三类：显式报错（约 21 家 provider 正则）、静默溢出（input+cacheRead 超窗）、
 * length 且零输出（截断填满型）。
 * @param contextWindow 模型上下文窗口——传入才启用静默溢出检测
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  return piIsContextOverflow(toPi(message), contextWindow);
}

/**
 * length 截止是否低于预期输出上限（上下文压力/供应商截断信号——
 * 允许上层做一次有界 compact-and-retry）。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
  return piIsRecoverableLength(toPi(message), desiredMaxOutput);
}

/** 失败消息是否像 transient（网络/限流类）错误——决定 turn 级重试是否值得 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  return piIsRetryable(toPi(message));
}

/**
 * 错误四桶（骨架篇 §3.4 三桶 + overflow 分类位）：transient/non-retryable/quota
 * 是消费动作桶（每桶一个动作无歧义态），overflow 只分类不消费（动作挂溢出兜底
 * compact-and-retry-once 纵切）。驱动 runTurns 重试循环只消费 'transient'。
 */
export type ErrorBucket = 'transient' | 'non-retryable' | 'quota' | 'overflow';

/**
 * 配额耗尽文案子集（pi-ai retry.ts NON_RETRYABLE 正则的配额族词表——
 * 该正则模块内私有不导出，此处同款自写；来源 2026-08-26 对照 0.84.2）。
 * quota 桶与 generic non-retryable 的分流：配额类失败要明示「重试治不了」
 * 的诊断语义（骨架篇 §3.4 桶③），不是重试判定差异——两者都不进 auto-retry。
 */
const QUOTA_TEXT_PATTERN =
  /(GoUsageLimit|FreeUsageLimit|Monthly usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing)/i;

/** 错误文案的取值面：errorMessage 优先，退而 content 首文本块（与 pi-ai 判定面同源） */
function errorText(message: AssistantMessage): string {
  if (message.errorMessage !== undefined && message.errorMessage !== '') return message.errorMessage;
  const text = message.content.find((block): block is { type: 'text'; text: string } => block.type === 'text');
  return text?.text ?? '';
}

/**
 * 错误桶判定（全仓唯一一份，骨架篇 §3.4 S4 落码形态——应用侧禁写第二份分桶）：
 * errorCode 在场码优先、文案正则兜底。判定序：
 * ① LLM_INFLIGHT_LIMIT（在飞帽拒绝）→ transient——并发压力自解，退避后槽已释放；
 * ② isContextOverflow → overflow（分类不消费）；
 * ③ 配额文案族 → quota（429/rate limit 不在此族——归 transient 桶，两阶段
 *    判定注记：S4 现实 errorCode 无 provider 写点，429 唯一现实路是正则→transient；
 *    M2 码归一后 429 携 LLM_RATE_LIMITED 走码优先 → quota，届时重审）；
 * ④ pi-ai isRetryable 正则（网络/5xx/429/overloaded/流早断）→ transient；
 * ⑤ 其余 → non-retryable（保守：未知错误不重试）。
 */
export function classifyAssistantError(message: AssistantMessage): ErrorBucket {
  // ① 宿主合成码优先（errorCode 是机器判定位，摆脱 [CODE] 文本前缀约定）
  if (message.errorCode === 'LLM_INFLIGHT_LIMIT') return 'transient';
  // ② 溢出分类位（约 21 家 provider 正则 + 静默溢出 + length 零输出）
  if (piIsContextOverflow(toPi(message))) return 'overflow';
  // ③ 配额族文案 → quota（在 isRetryable 之前测：insufficient_quota 在 pi-ai
  //    归 non-retryable，此处细分到 quota 桶供诊断面区分）
  if (QUOTA_TEXT_PATTERN.test(errorText(message))) return 'quota';
  // ④ transient 正则（429/5xx/网络/流早断）
  if (piIsRetryable(toPi(message))) return 'transient';
  // ⑤ 保守默认：未知即不可重试（auth/参数/内容策略类重试只会再失败）
  return 'non-retryable';
}

/**
 * 单次 assistant 产出的有界重试（会话层 turn 级 auto-retry 实现零件，骨架篇 §3.2
 * 第三行；pi 原用途挂 compaction 摘要旁路）。abort 归一为 aborted 消息、非可重试
 * 错误立即返回、成功即返回——语义细节见 pi-ai retry.ts 文档注释。
 */
export async function retryAssistantCall(
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy,
  signal?: AbortSignal,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  const final = await piRetryAssistantCall(async () => toPi(await produce()), policy, signal, callbacks);
  return final as unknown as AssistantMessage;
}
