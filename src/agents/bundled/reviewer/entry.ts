/**
 * ②reviewer agent 进程入口（架构升级 16.0 §4.0 议会拆分）—— 产出审核专员。
 *
 * 从 brain 拆出的独立审核 agent。复用 brain 已提取的 review 纯资产（evaluateReview /
 * buildReviewSystemPrompt / DEFAULT_REVIEW_PROMPT_* / createBrainHelpers / createCheckerDispatch /
 * setupReviewFeedbackHandler）。审核核心逻辑在 produce-review.ts（可单测，无进程副作用）。
 *
 * 行为等价 brain 原 review.request handler（含 checker/plan mark/fallback/slot）—— 翻转后是
 * review 链路唯一审核者。Stage：加 agent.json(roles:['reviewer']) + brain 去 reviewer role 即翻转。
 */

import { startResidentAgent } from '../../resident-agent.js';
import { getDb } from '../../../memory/index.js';
import type { IpcMessage } from '../../../kernel/types.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { ObservationRecorder } from '../../../kernel/observation-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';
import { MissionManager } from '../../../kernel/mission-manager.js';
import { FallbackReviewer } from '../../../kernel/fallback-reviewer.js';
import { DEFAULT_REVIEW_PROMPT_A, DEFAULT_REVIEW_PROMPT_BC } from '../brain/prompts.js';
import { createBrainHelpers } from '../brain/brain-helpers.js';
import { createCheckerDispatch } from '../brain/checker-dispatch.js';
import { setupReviewFeedbackHandler } from '../brain/review-feedback-handler.js';
import { produceReviewResult, type ReviewerReviewContext } from './produce-review.js';

startResidentAgent(({ name, ipc, llm, db }) => {
  const promptVersioning = new PromptVersioning(db);
  const decisionRecorder = new BrainDecisionRecorder(db);
  const observationRecorder = new ObservationRecorder(db);
  const missionManager = new MissionManager();
  const fallbackReviewer = new FallbackReviewer();

  // 复用 brain helper 工厂，只用 review 相关（routing/permission 留 brain）
  const { recallDecisionsBlock, getReviewPrompt, buildFallbackReviewResult, acquireReviewSlot, releaseReviewSlot } = createBrainHelpers({ decisionRecorder, promptVersioning, fallbackReviewer, name, defaultPromptA: DEFAULT_REVIEW_PROMPT_A, defaultPromptBc: DEFAULT_REVIEW_PROMPT_BC });

  const dispatchCheckerReview = createCheckerDispatch({ missionManager, decisionRecorder, ipc });
  setupReviewFeedbackHandler({ db, decisionRecorder, promptVersioning, ipc, defaultPromptA: DEFAULT_REVIEW_PROMPT_A, defaultPromptBc: DEFAULT_REVIEW_PROMPT_BC });

  const ctx: ReviewerReviewContext = {
    db,
    observationRecorder,
    missionManager,
    getBasePrompt: getReviewPrompt,
    recallDecisionsBlock,
    acquireReviewSlot,
    releaseReviewSlot,
    buildFallbackReviewResult,
    dispatchCheckerReview,
    recordReviewDecision: (sessionId, draft, review, planTaskId) => decisionRecorder.recordReviewDecision(sessionId, draft, review, planTaskId),
    updatePlan: (missionId, update) => missionManager.updatePlan(missionId, update as never),
  };

  // --- Handler: review.request（行为等价 brain 原 handler）---
  ipc.onMessage('review.request', async (msg: IpcMessage) => {
    const { turn } = msg.payload as { turn: Parameters<typeof produceReviewResult>[0] };
    const trackingId = msg.correlationId ?? msg.id;
    const reviewResult = await produceReviewResult(
      turn,
      trackingId,
      (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]),
      ctx,
      name,
    );
    ipc.send('review.result', 'core', reviewResult, trackingId);
  });
});
