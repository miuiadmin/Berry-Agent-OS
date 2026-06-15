/**
 * review.request 核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取，最大单块）。
 *
 * buildReviewInput → chat → JSON 解析 + verdict 校验 + escalation → fallback。
 * systemPrompt 由 entry.ts 构造（world model + observations + board context + insights 闭包）。
 * fallback 函数注入（buildFallbackReviewResult 是 entry.ts 闭包，不搬迁）。
 * entry.ts 保留 acquireReviewSlot/releaseReviewSlot + dispatchCheckerReview + ipc.send。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { ReviewResult, ReviewLevel, TurnRecord } from '../../../contracts/review.js';
import type { BrainEscalation } from '../../../contracts/brain.js';
import { buildReviewInput } from './prompts.js';

type ChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;
type FallbackFn = (turn: TurnRecord, reason: string) => ReviewResult;

/**
 * review.request LLM 调用 + 解析 + fallback。
 *
 * @param turn         审核轮次（level + sessionId + draftResponse + toolCalls）
 * @param systemPrompt 已构造好的 system prompt（entry.ts 注入 world model + observations + board + insights）
 * @param chat         LLM chat 函数
 * @param name         brain agent 名
 * @param trackingId   IPC 跟踪 id
 * @param fallback     降级函数（entry.ts 的 buildFallbackReviewResult 闭包）
 * @returns 审核结果（verdict + finalResponse + reason + reRoute + escalation）
 */
export async function evaluateReview(
  turn: TurnRecord,
  systemPrompt: string,
  chat: ChatFn,
  name: string,
  trackingId: string,
  fallback: FallbackFn,
): Promise<ReviewResult> {
  const reviewContent = buildReviewInput(turn.level, turn);
  let result: { content: string };
  try {
    result = await chat([{ role: 'user', content: reviewContent }], {
      system: systemPrompt,
      maxTokens: turn.level === 'A' ? 1024 : 2048,
      temperature: 0.3,
      agent: name,
      purpose: 'brain_review',
      sessionId: turn.sessionId,
      correlationId: trackingId,
    });
  } catch {
    // LLM 调用失败 → fallback（不阻塞审核流程）
    return fallback(turn, 'Brain LLM 不可用');
  }

  // 容错 JSON 解析（LLM 可能用 ```json 包裹或附加文字）
  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in review response');
    const parsed = JSON.parse(jsonMatch[0]);
    // 校验 verdict 合法性，非法值回退为 reject（保守策略）
    const validVerdicts = ['approve', 'modify', 'reject'] as const;
    const verdict = validVerdicts.includes(parsed.verdict) ? parsed.verdict : 'reject';
    // 解析 uncertain 升级（Brain 审核拿不准质量时）
    let escalation: BrainEscalation | undefined;
    if (Boolean(parsed.uncertain) && typeof parsed.escalationQuestion === 'string' && parsed.escalationQuestion.trim()) {
      escalation = {
        source: 'review',
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'Brain 审核不确定回复质量',
        questionToUser: parsed.escalationQuestion.trim(),
      };
    }
    return {
      verdict,
      finalResponse: parsed.finalResponse,
      reason: parsed.reason,
      reRoute: parsed.reRoute || undefined,
      escalation,
    };
  } catch {
    // 解析失败 → fallback（禁止默认批准，违反"所有回复必须经 Brain 审核"硬规则）
    return fallback(turn, 'Brain review 响应解析失败');
  }
}
