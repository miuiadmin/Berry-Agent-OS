/**
 * ②reviewer 审核核心（可测，无 startResidentAgent 副作用）。
 *
 * produceReviewResult = buildReviewSystemPrompt + evaluateReview + checker/plan/record/fallback/slot，
 * 与 brain 原 review.request handler 行为等价（§17.4 + ①②第1步：复用三件 review 纯资产）。
 * entry.ts 进程入口调用本函数；单测直接测本函数（注入 mock chat + mock ctx）。
 */

import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import type { ModelMessage } from '../../../contracts/model.js';
import type { ToolBlock } from '../../../contracts/message-blocks.js';
import type { ReviewResult, TurnRecord } from '../../../contracts/review.js';
import {
  buildReviewSystemPrompt,
  type ReviewPromptContext,
} from '../brain/review-prompt-builder.js';
import { evaluateReview } from '../brain/review-handler.js';

const logger = getLogger('reviewer');

/** chat 函数类型（生产=llm.current.chat，测试=mock 返固定 verdict JSON） */
export type ReviewerChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/** produceReviewResult 依赖（②reviewer 进程构造，测试注入 mock） */
export interface ReviewerReviewContext extends ReviewPromptContext {
  /** §5.2.5 并发审核 slot 控制（createBrainHelpers 提供） */
  acquireReviewSlot: () => Promise<void>;
  releaseReviewSlot: () => void;
  /** fallback 审核结果（LLM 不可用时，FallbackReviewer 规则化） */
  buildFallbackReviewResult: (turn: TurnRecord, reason: string) => ReviewResult;
  /** P10 checker 派发（有 mission 上下文时；可选） */
  dispatchCheckerReview?: (missionId: string, planTaskId: string, turn: TurnRecord, reviewResult: ReviewResult, trackingId: string) => void;
  /** 审核决策记录（BrainDecisionRecorder.recordReviewDecision） */
  recordReviewDecision: (sessionId: string, draft: string, review: Record<string, unknown>, planTaskId: string) => void;
  /** mission plan 状态更新（approve/modify→done, reject→failed；可选） */
  updatePlan?: (missionId: string, update: { task_id: string; status: string; result: string }) => void;
}

/**
 * review.request 核心处理（可测，行为等价 brain 原 handler）。
 *
 * @param turn       审核轮次
 * @param trackingId IPC 跟踪 id
 * @param chat       LLM chat 函数
 * @param ctx        ②reviewer 依赖
 * @param agentName  agent 名（LLM chat 的 agent 字段）
 * @returns 审核结果（verdict/finalResponse/reason/escalation）—— 调用方据 ipc.send('review.result')
 */
export async function produceReviewResult(
  turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: ToolBlock[]; level: 'A' | 'B' | 'C'; missionId?: string; planTaskId?: string; taskDescription?: string; boardTaskId?: string },
  trackingId: string,
  chat: ReviewerChatFn,
  ctx: ReviewerReviewContext,
  agentName: string,
): Promise<ReviewResult> {
  // §5.2.5: 并发审核准入控制
  await ctx.acquireReviewSlot();
  try {
    const systemPrompt = buildReviewSystemPrompt(turn, ctx);

    try {
      const reviewResult = await evaluateReview(turn as TurnRecord, systemPrompt, chat, agentName, trackingId, ctx.buildFallbackReviewResult);

      logger.debug({ level: turn.level, verdict: reviewResult.verdict, reason: safeSlice(reviewResult.reason, 200), hasReRoute: !!reviewResult.reRoute, draftLen: turn.draftResponse?.length }, 'reviewer:review');

      // 13.0 P10: 派发独立 checker（不阻塞主 review.result）
      if (turn.planTaskId && turn.missionId && ctx.dispatchCheckerReview) {
        ctx.dispatchCheckerReview(turn.missionId, turn.planTaskId, turn as TurnRecord, reviewResult, trackingId);
      }

      // 13.0 §12: 记录审核决策
      ctx.recordReviewDecision(
        turn.sessionId,
        turn.draftResponse ?? turn.userMessage,
        reviewResult as unknown as Record<string, unknown>,
        turn.planTaskId ?? trackingId,
      );

      // 13.0 §12.6: 自动 mark plan task（approve/modify→done, reject→failed）
      if (turn.planTaskId && turn.missionId && ctx.updatePlan) {
        try {
          const isReject = reviewResult.verdict === 'reject';
          ctx.updatePlan(turn.missionId, {
            task_id: turn.planTaskId,
            status: isReject ? 'failed' : 'done',
            result: (isReject ? (reviewResult.reason ?? '审核拒绝') : (reviewResult.finalResponse ?? reviewResult.reason ?? '审核通过')).slice(0, 2000),
          });
        } catch (planErr) {
          logger.warn({ err: planErr, missionId: turn.missionId, planTaskId: turn.planTaskId }, 'reviewer:review plan auto-update failed');
        }
      }

      return reviewResult;
    } catch (err) {
      // §5.2.5 失败降级：LLM 不可用 → FallbackReviewer 规则化审查
      logger.warn({ err: (err as Error).message }, 'reviewer:review LLM call failed, falling back to FallbackReviewer');
      const fallbackReviewResult = ctx.buildFallbackReviewResult(turn as TurnRecord, 'Reviewer LLM 不可用');

      ctx.recordReviewDecision(
        turn.sessionId,
        turn.draftResponse ?? turn.userMessage,
        fallbackReviewResult as unknown as Record<string, unknown>,
        turn.planTaskId ?? trackingId,
      );

      // §13.21: 降级审核也标 plan task，防 mission 挂起
      if (turn.planTaskId && turn.missionId && ctx.updatePlan) {
        try {
          const isApprove = fallbackReviewResult.verdict === 'approve' || fallbackReviewResult.verdict === 'modify';
          ctx.updatePlan(turn.missionId, {
            task_id: turn.planTaskId,
            status: isApprove ? 'done' : 'failed',
            result: (fallbackReviewResult.reason ?? (isApprove ? '降级审核通过' : '降级审核拒绝')).slice(0, 2000),
          });
        } catch (planErr) {
          logger.warn({ err: planErr }, 'reviewer:fallback review plan auto-update failed');
        }
      }

      return fallbackReviewResult;
    }
  } finally {
    // §5.2.5: 释放审核 slot
    ctx.releaseReviewSlot();
  }
}
