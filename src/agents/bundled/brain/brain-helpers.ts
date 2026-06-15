/**
 * brain/entry.ts 剩余小闭包 helpers（§17.4 巨石拆解收尾——7 个闭包函数工厂提取）。
 *
 * recallDecisionsBlock / getReviewPrompt / getRoutingPrompt / getPermissionPrompt /
 * buildFallbackReviewResult / acquireReviewSlot / releaseReviewSlot —— 全是依赖 entry.ts
 * 实例变量的小闭包。合并到一个工厂函数返回，entry.ts 一行调用拿到全部。
 */

import type { IpcMessage } from '../../../kernel/types.js';
import type { ReviewResult } from '../../../contracts/review.js';
import type { ReviewLevel } from '../../../contracts/review.js';
import type { ToolBlock } from '../../../contracts/message-blocks.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { buildRoutingSystemPrompt, buildPermissionJudgeSystemPrompt } from './prompts.js';
import { getLogger } from '../../../utils/logger.js';

/** deps 注入 */
export interface BrainHelpersDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decisionRecorder: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promptVersioning: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallbackReviewer: any;
  name: string;
  defaultPromptA: string;
  defaultPromptBc: string;
}

/** 并发审核上限 */
const MAX_CONCURRENT_REVIEWS = 5;

/**
 * 工厂：创建 7 个 brain helper 闭包函数。
 * entry.ts: const { recallDecisionsBlock, getReviewPrompt, ... } = createBrainHelpers({ ... });
 */
export function createBrainHelpers(deps: BrainHelpersDeps) {
  const { decisionRecorder, promptVersioning, fallbackReviewer, name, defaultPromptA, defaultPromptBc } = deps;
  const logger = getLogger('brain-helpers');
  let activeReviewCount = 0;
  const reviewQueue: Array<{ resolve: () => void }> = [];

  /** §5.2 ④: 历史决策参考 block（注入 systemPrompt 供 brain 学习过往） */
  function recallDecisionsBlock(decisionType: string): string {
    const decisions = decisionRecorder.recallForDecision(decisionType, 5);
    if (decisions.length === 0) return '';
    const lines = decisions.map((d: { inputSummary: string; outcome?: string; lesson?: string }) => {
      const outcome = d.outcome ? ` [${d.outcome}]` : '';
      const lesson = d.lesson ? ` 教训: ${d.lesson}` : '';
      return `- ${safeSlice(d.inputSummary, 80)}${outcome}${lesson}`;
    });
    return `\n\n## 历史决策参考\n\n${lines.join('\n')}\n`;
  }

  /** 获取审核 prompt（versioning 优先，回退默认） */
  function getReviewPrompt(level: ReviewLevel): string {
    const key = level === 'A' ? 'brain.review.a' : 'brain.review.bc';
    return promptVersioning.getActiveVersion(key)?.content ?? (level === 'A' ? defaultPromptA : defaultPromptBc);
  }

  /** 获取路由 prompt（versioning 优先，回退默认） */
  function getRoutingPrompt(): string {
    return promptVersioning.getActiveVersion('brain.routing')?.content ?? buildRoutingSystemPrompt();
  }

  /** 获取权限判断 prompt（versioning 优先，回退默认） */
  function getPermissionPrompt(): string {
    return promptVersioning.getActiveVersion('brain.permission')?.content ?? buildPermissionJudgeSystemPrompt();
  }

  /** FallbackReviewer 规则化降级审核（LLM 不可用/解析失败时） */
  function buildFallbackReviewResult(
    turn: { draftResponse?: string; toolCalls: ToolBlock[] },
    cause: string,
  ): ReviewResult {
    const fallbackResult = fallbackReviewer.review({
      responseText: turn.draftResponse ?? '',
      hasToolCalls: turn.toolCalls.length > 0,
      toolNames: turn.toolCalls.map((tc) => tc.name),
      agentName: name,
    });
    switch (fallbackResult.verdict) {
      case 'deny': return { verdict: 'reject', reason: `${cause}，规则审核拒绝: ${fallbackResult.reason}` };
      case 'hold': return { verdict: 'modify', reason: `${cause}，规则审核标记需人工确认: ${fallbackResult.reason}` };
      default: return { verdict: 'approve', reason: `${cause}，规则审核批准: ${fallbackResult.reason}` };
    }
  }

  /** §5.2.5: 并发审核准入——获取 slot（排队等待） */
  function acquireReviewSlot(): Promise<void> {
    if (activeReviewCount < MAX_CONCURRENT_REVIEWS) {
      activeReviewCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      reviewQueue.push({ resolve });
      logger.debug({ activeCount: activeReviewCount, queueLength: reviewQueue.length }, 'brain:review queued');
    });
  }

  /** §5.2.5: 释放 slot（唤醒下一个排队的） */
  function releaseReviewSlot(): void {
    activeReviewCount = Math.max(0, activeReviewCount - 1);
    if (reviewQueue.length > 0) {
      activeReviewCount++;
      reviewQueue.shift()!.resolve();
    }
  }

  return { recallDecisionsBlock, getReviewPrompt, getRoutingPrompt, getPermissionPrompt, buildFallbackReviewResult, acquireReviewSlot, releaseReviewSlot };
}
