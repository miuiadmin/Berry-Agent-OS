/**
 * L3 compaction — 压缩策略纯函数（会话篇 §2 增补七条，2026-08-26 纵切落码）。
 *
 * 本文件是策略的纯逻辑半边：判阈 / 遮蔽区间规划 / 防抖判定 / 摘要预算——
 * 全部无 IO 无副作用，单测主战场（件本体 plugin.ts 只做编排与落账）。
 * 形状来源：Hermes context_compressor.py 五件提取（台账 #29）+ 冷读七条回写。
 */

import type { ProjectedMessage } from '../session/derive.js';

/* ------------------------------------------------------------------ */
/* 判阈（增补 4：真 token 优先 + 粗估兜底诚实低估）                     */
/* ------------------------------------------------------------------ */

/** 判阈输入（plugin 编排层采集——三源各可能缺位） */
export interface ThresholdInput {
  /** 末条主 loop 用量 input（llm/usage 中 callId `turn:` 前缀笔；null = 无主 loop 笔） */
  readonly lastLoopUsageInput: number | null;
  /** 模型上下文窗口（getModel 元数据；undefined = 目录无此模型） */
  readonly contextWindow: number | undefined;
  /** 投影字符量（粗估源——JSON 序列化长度） */
  readonly projectedChars: number;
  /** 触发阈值比例（config thresholdRatio，缺省 0.5） */
  readonly thresholdRatio: number;
  /** 窗口未知时的兜底假设窗口 tokens（config fallbackWindowTokens，缺省 200k） */
  readonly fallbackWindowTokens: number;
}

/** 判阈结果 */
export interface ThresholdVerdict {
  /** 是否过阈触发压缩 */
  readonly fire: boolean;
  /** 判据源：usage = 真 token 笔；estimate = 字符粗估（诚实低估注记——不含工具 schema） */
  readonly basis: 'usage' | 'estimate';
  /** 本判据下的 token 估值（观测/落账用） */
  readonly estTokens: number;
  /** 生效窗口（真实或兜底——观测/落账用） */
  readonly effectiveWindow: number;
}

/**
 * 判阈：真 token 优先，粗估兜底。
 * - 有主 loop usage 笔：input ≥ effectiveWindow × ratio（API 回报真值——Hermes
 *   #2153/#12026 教训面：只认主 loop 笔不认 complete 单发笔）；
 * - 无 usage 笔（首轮 / 断线后 0 退）：粗估 chars/4 ≥ 同阈（#14695 教训面：
 *   粗估不含工具 schema 必然低估——诚实接受迟一轮，真值下轮即到）。
 */
export function evaluateThreshold(input: ThresholdInput): ThresholdVerdict {
  const effectiveWindow = input.contextWindow ?? input.fallbackWindowTokens;
  const limit = effectiveWindow * input.thresholdRatio;
  if (input.lastLoopUsageInput !== null && input.lastLoopUsageInput > 0) {
    return {
      fire: input.lastLoopUsageInput >= limit,
      basis: 'usage',
      estTokens: input.lastLoopUsageInput,
      effectiveWindow,
    };
  }
  const estTokens = Math.ceil(input.projectedChars / 4);
  return { fire: estTokens >= limit, basis: 'estimate', estTokens, effectiveWindow };
}

/* ------------------------------------------------------------------ */
/* 遮蔽区间规划（增补 1 + 边缘纪律 1：head 保护 / tail 保留 / 配对整对） */
/* ------------------------------------------------------------------ */

/** 区间规划结果 */
export interface SegmentPlan {
  /** 遮蔽区间（事件 seq 闭区间——区间内全部事件被遮，含 log-only） */
  readonly start: number;
  readonly end: number;
  /** 区间内被压缩的消息数（落账观测用） */
  readonly occludedMessages: number;
  /** 被压缩内容的字符量（摘要预算基数） */
  readonly occludedChars: number;
}

/**
 * 规划遮蔽区间：head 保首条消息（任务锚）+ tail 保末 tailKeep 条 + 中段全遮。
 *
 * 配对不切断由宿主 validateSurfaceOp 统一执法（边缘纪律 1）——本函数只按
 * 消息锚 seq 切界（head 锚 seq 之后到 tail 最小锚 seq 之前）；若切界恰好
 * 落在配对中间，宿主断言拒写、件按失败降级（冷却重试），下次 tail 界推移
 * 自然避开——不在此重写配对逻辑（单一执法点纪律）。
 *
 * @returns null = 最小条数不足（head 1 + tail N + 摘要占位放不下即不压——
 * 探针反例：3 条 27KiB 压出 5 条 41KiB）
 */
export function planSegment(messages: readonly ProjectedMessage[], tailKeep: number): SegmentPlan | null {
  // 最小条数保护（探针反例：3 条 27KiB 压出 5 条 41KiB）：head 1 + tail N 之外
  // 中段至少 1 条（length ≥ 2 + tailKeep）——放不下摘要占位的压缩是负收益
  if (messages.length < 2 + tailKeep) {
    return null;
  }
  const headSeq = messages[0]!.seq;
  const tailStart = messages[messages.length - tailKeep]!;
  const start = headSeq + 1;
  const end = tailStart.seq - 1;
  if (end < start) {
    return null;
  }
  // 中段消息数与字符量（摘要预算基数）——锚 seq 落在 (headSeq, tailStart.seq) 开区间内者
  const occluded = messages.filter((m) => m.seq > headSeq && m.seq < tailStart.seq);
  return {
    start,
    end,
    occludedMessages: occluded.length,
    occludedChars: JSON.stringify(occluded).length,
  };
}

/* ------------------------------------------------------------------ */
/* 防抖（增补 4：连续节省 <10% 跳过 + 冷却从日志 derive）               */
/* ------------------------------------------------------------------ */

/** 防抖参数 */
export interface DebounceInput {
  /** 压缩前主 loop input */
  readonly beforeInput: number;
  /** 播种生效后的主 loop input（冷读 M-1：防抖判据以播种生效后的 usage 为准） */
  readonly afterInput: number;
  /** 连续低节省计数（件内 per-session 状态——本函数纯计算不持态） */
  readonly consecutiveLowSavings: number;
}

/** 防抖结果 */
export interface DebounceVerdict {
  /** true = 本轮压缩后判定「连续两次节省 <10%」——跳过后续触发直到上下文再涨 */
  readonly suppress: boolean;
  /** 更新后的连续计数 */
  readonly nextCount: number;
}

/**
 * 防抖判定：单轮节省比例 = (before - after) / before；<10% 计数 +1，连续两次
 * 即 suppress（Hermes #12026 同族——防「每轮只省一两成边际」的空转压缩链）。
 * after ≥ before（压缩无效）直接计入（节省 0）。
 */
export function evaluateDebounce(input: DebounceInput): DebounceVerdict {
  const saving = input.beforeInput > 0 ? (input.beforeInput - input.afterInput) / input.beforeInput : 0;
  const nextCount = saving < 0.1 ? input.consecutiveLowSavings + 1 : 0;
  return { suppress: nextCount >= 2, nextCount };
}

/**
 * 冷却判定（durable derive——增补 6 冷读 M-4：冷却态从 compaction/failed 事件
 * 日志重推导，不持内存态）：末次失败时间在冷却窗内即冷却中。
 * 重启不重试持续性 provider 故障——失败事实在日志里。
 */
export function inCooldown(lastFailedAt: number | null, now: number, cooldownMs: number): boolean {
  return lastFailedAt !== null && now - lastFailedAt < cooldownMs;
}

/* ------------------------------------------------------------------ */
/* 摘要预算与提示词（增补 5：五段模板 + 迭代更新 + 预算三参）            */
/* ------------------------------------------------------------------ */

/** 摘要预算三参（config 透传，Hermes 三常数形状） */
export interface SummaryBudget {
  /** 摘要长度 = 被压缩内容 token 量 × ratio */
  readonly ratio: number;
  /** 预算下限（tokens——短内容也别压得过狠） */
  readonly min: number;
  /** 预算上限（tokens——长内容摘要别无限涨） */
  readonly max: number;
}

/** 摘要 token 预算（被压缩内容字符量 → 摘要预算 tokens，三参钳制） */
export function summaryBudgetFor(occludedChars: number, budget: SummaryBudget): number {
  const est = Math.ceil((occludedChars / 4) * budget.ratio);
  return Math.max(budget.min, Math.min(budget.max, est));
}

/** 摘要文本的防注入前缀标记（框架句式与用户原文可分辨——增补 5） */
export const SUMMARY_PREFIX = '[COMPACTION-SUMMARY]';

/**
 * 构造摘要提示词：五段结构化模板 + 迭代更新（前次摘要并入——多次压缩信息
 * 不丢，durable 天然可查：前次 compaction/summary 事件从日志读出传入）。
 */
export function buildSummaryPrompt(
  occludedMessages: readonly ProjectedMessage[],
  previousSummary: string | null,
  budgetTokens: number,
): string {
  const serialized = JSON.stringify(occludedMessages);
  const parts = [
    '你在为一段智能体会话做上下文压缩摘要。请把下列被压缩的对话内容总结为五个小节，',
    '每节用一行或多行要点：Goal（任务目标）/ Progress（已完成的进展）/ Decisions（做出的决定）',
    '/ Resolved（已解决的问题）/ Pending（未决事项与下一步）。',
  ];
  if (previousSummary !== null) {
    parts.push('这是本会话此前的压缩摘要，请把它的信息合并进新摘要（信息不丢）：', previousSummary);
  }
  parts.push(`摘要长度预算约 ${budgetTokens} tokens。被压缩内容：`, serialized);
  return parts.join('\n');
}
