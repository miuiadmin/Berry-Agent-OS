/**
 * dispatchCheckerReview（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * P10 独立 checker 审核：通过 MissionManager.getCheckerForPlanTask 找到 squad check 角色成员，
 * IPC 发 brain.checker.dispatch 给 core（core re-emit EventBus）。不阻塞主 review.result。
 */

import type { ReviewResult } from '../../../contracts/review.js';
import type { ToolBlock } from '../../../contracts/message-blocks.js';
import { genId } from '../../../utils/id.js';
import { getLogger } from '../../../utils/logger.js';

/** deps 注入 */
export interface CheckerDispatchDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  missionManager: any;
  // eslint-disable-next-line @typescript-eslint-eslint/no-explicit-any
  decisionRecorder: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc: any;
}

/**
 * 创建 dispatchCheckerReview 函数（工厂模式，deps 注入）。
 * entry.ts: const dispatchCheckerReview = createCheckerDispatch({ missionManager, decisionRecorder, ipc });
 */
export function createCheckerDispatch(deps: CheckerDispatchDeps) {
  const { missionManager, decisionRecorder, ipc } = deps;
  const logger = getLogger('brain-checker-dispatch');

  return function dispatchCheckerReview(
    missionId: string,
    planTaskId: string,
    turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: ToolBlock[]; taskDescription?: string },
    brainReviewResult: ReviewResult,
    parentCorrelationId: string,
  ): void {
    try {
      const checker = missionManager.getCheckerForPlanTask(missionId, planTaskId);
      if (!checker) return;

      const checkerCorrelationId = genId('check');
      ipc.send('brain.checker.dispatch', 'core', {
        missionId, planTaskId, sessionId: turn.sessionId,
        checkerAgent: checker.agent, checkerOn: checker.on,
        checkerCorrelationId, parentCorrelationId,
        workerOutput: turn.draftResponse,
        workerTask: turn.taskDescription ?? planTaskId,
        brainVerdict: brainReviewResult.verdict,
        brainReason: brainReviewResult.reason ?? '',
      });

      decisionRecorder.record({
        sessionId: turn.sessionId, decisionType: 'review',
        inputSummary: `dispatched checker review for planTaskId=${planTaskId}`,
        outputJson: {
          action: 'dispatch_checker', checkerAgent: checker.agent,
          parentCorrelationId, checkerCorrelationId,
          brainVerdict: brainReviewResult.verdict, missionId, planTaskId,
        },
      });

      logger.info({ missionId, planTaskId, checkerAgent: checker.agent, checkerCorrelationId, brainVerdict: brainReviewResult.verdict }, 'brain:p10 checker review dispatched');
    } catch (err) {
      logger.warn({ err, missionId, planTaskId }, 'brain:p10 dispatchCheckerReview failed');
    }
  };
}
