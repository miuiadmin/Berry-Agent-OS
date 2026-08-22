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
