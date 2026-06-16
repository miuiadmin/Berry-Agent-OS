/**
 * ①permission agent 审核核心（可测，无 startResidentAgent 副作用）。
 *
 * producePermissionJudge = 构造 systemPrompt（base + insights + 历史决策）+ evaluatePermissionJudge + 记录，
 * 与 brain 原 permission.judge handler 行为等价（§17.4：复用 evaluatePermissionJudge 纯函数）。
 */

import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import type { ModelMessage } from '../../../contracts/model.js';
import type { PermissionJudgeRequestPayload, PermissionJudgeResultPayload } from '../../../contracts/routing.js';
import { recallInsightsForDecision, formatInsightsBlock } from '../../../kernel/insights-recall.js';
import { markInsightAdoptedByDecision } from '../../../kernel/insights-lifecycle.js';
import { evaluatePermissionJudge } from '../brain/permission-handler.js';

const logger = getLogger('permission');

/** chat 函数类型（生产=llm.current.chat，测试=mock） */
export type PermissionChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/** producePermissionJudge 依赖（①permission 进程构造，测试注入 mock） */
export interface PermissionJudgeContext {
  db: import('better-sqlite3').Database;
  /** 基础 permission systemPrompt（createBrainHelpers.getPermissionPrompt，带 promptVersioning） */
  getPermissionPrompt: () => string;
  /** 历史决策回溯 block（createBrainHelpers.recallDecisionsBlock） */
  recallDecisionsBlock: (decisionType: string) => string;
  /** 记录权限决策（BrainDecisionRecorder.recordPermissionDecision） */
  recordPermissionDecision: (sessionId: string, toolName: string, judgment: Record<string, unknown>) => void;
}

/**
 * permission.judge 核心处理（可测，行为等价 brain 原 handler）。
 *
 * @returns 权限裁决（allowed/reason/...）—— 调用方据 ipc.send('permission.judge.result')
 */
export async function producePermissionJudge(
  payload: PermissionJudgeRequestPayload,
  trackingId: string,
  chat: PermissionChatFn,
  ctx: PermissionJudgeContext,
  agentName: string,
): Promise<PermissionJudgeResultPayload> {
  // systemPrompt 构造（base + insights + 历史决策）
  let systemPrompt = ctx.getPermissionPrompt();
  const permInsights = recallInsightsForDecision(ctx.db, 'permission', 3);
  if (permInsights.length > 0) {
    systemPrompt += formatInsightsBlock(permInsights);
    markInsightAdoptedByDecision(ctx.db, 'permission', permInsights.map(i => i.id));
  }
  systemPrompt += ctx.recallDecisionsBlock('permission');

  try {
    const judgment = await evaluatePermissionJudge(payload, systemPrompt, chat, agentName, trackingId);
    logger.debug({ tool: payload.toolName, allowed: judgment.allowed, reason: safeSlice(judgment.reason, 200) }, 'permission:judge');
    ctx.recordPermissionDecision(payload.sessionId, payload.toolName, judgment as unknown as Record<string, unknown>);
    return judgment as PermissionJudgeResultPayload;
  } catch (err) {
    // fail-closed：LLM 失败 → 拒绝（与 brain 原行为一致，权限保守）
    return { allowed: false, reason: `权限判断 LLM 失败: ${(err as Error).message}` } satisfies PermissionJudgeResultPayload;
  }
}
