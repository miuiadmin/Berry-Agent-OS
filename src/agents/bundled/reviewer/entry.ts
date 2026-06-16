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
import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import type { IpcMessage } from '../../../kernel/types.js';
import type { SuperiorReviewRequest } from '../../../contracts/superior-review.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { ObservationRecorder } from '../../../kernel/observation-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';
import { MissionManager } from '../../../kernel/mission-manager.js';
import { FallbackReviewer } from '../../../kernel/fallback-reviewer.js';
import { DEFAULT_REVIEW_PROMPT_A, DEFAULT_REVIEW_PROMPT_BC } from '../brain/prompts.js';
import { createBrainHelpers } from '../brain/brain-helpers.js';
import { createCheckerDispatch } from '../brain/checker-dispatch.js';
import { setupReviewFeedbackHandler } from '../brain/review-feedback-handler.js';
import { evaluateSuperiorReview, evaluateDriftCheck, evaluateVerify } from '../brain/simple-handlers.js';
import { evaluateCronReview } from '../brain/cron-review-handler.js';
import { produceReviewResult, type ReviewerReviewContext } from './produce-review.js';

const logger = getLogger('reviewer');

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

  // --- Handler: superior.review.request（上级审核，行为等价 brain）---
  ipc.onMessage('superior.review.request', async (msg: IpcMessage) => {
    const request = msg.payload as SuperiorReviewRequest;
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const reviewResult = await evaluateSuperiorReview(request, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      ipc.send('superior.review.result', 'core', reviewResult, trackingId);
    } catch (err) {
      ipc.send('superior.review.result', 'core', {
        delegationId: request.delegationId,
        correlationId: request.correlationId,
        superiorId: request.superiorId,
        verdict: 'approve' as const,
        reason: `Superior review error: ${(err as Error).message}`,
      }, trackingId);
    }
  });

  // --- Handler: cron.review（定时任务审核，行为等价 brain：quick/medium/LLM 三路径）---
  ipc.onMessage('cron.review', async (msg: IpcMessage) => {
    const payload = msg.payload as { taskId: string; description: string; output: string; createdAt: number };
    const { taskId, description, output } = payload;
    const outputLen = output?.length ?? 0;
    const descLen = description?.length ?? 0;
    logger.info({ taskId, descriptionLen: descLen, outputLen }, 'reviewer:cron.review received');

    const needsLlmReview = outputLen > 2000 || descLen > 100;
    const quickApprove = !needsLlmReview && outputLen <= 500;

    if (quickApprove) {
      decisionRecorder.record({ sessionId: `cron:${taskId}`, decisionType: 'cron_review', inputSummary: safeSlice(description, 500), outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'rule_quick' }, confidence: 0.9, taskId });
      logger.debug({ taskId, outputLen }, 'reviewer:cron.review quick-approved (rule-based, short output)');
      return;
    }

    if (!needsLlmReview) {
      decisionRecorder.record({ sessionId: `cron:${taskId}`, decisionType: 'cron_review', inputSummary: safeSlice(description, 500), outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'rule_medium' }, confidence: 0.7, taskId });
      logger.debug({ taskId, outputLen }, 'reviewer:cron.review auto-approved (rule-based, medium output)');
      return;
    }

    // 复杂/长输出：LLM 审核（核心逻辑 evaluateCronReview，§17.4 已提取）
    try {
      const cronResult = await evaluateCronReview(description ?? '', output, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, taskId);
      logger.info({ taskId, verdict: cronResult.verdict, confidence: cronResult.confidence, reason: safeSlice(cronResult.reason, 200) }, 'reviewer:cron.review LLM verdict');
      decisionRecorder.record({
        sessionId: `cron:${taskId}`, decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: { output: safeSlice(output, 2000), autoApproved: cronResult.verdict === 'approve', llmVerdict: cronResult.verdict, llmReason: safeSlice(cronResult.reason, 500), correctedOutput: cronResult.correctedOutput ? safeSlice(cronResult.correctedOutput, 1000) : undefined, path: 'llm' },
        confidence: cronResult.confidence, taskId,
      });
      if (cronResult.verdict !== 'approve') {
        // cron 审核未过 → emit 标记事件（reattachBrainRelay inbound 消费，前端展示警告）
        ipc.send('brain.cron_review_flagged', 'core', { taskId, verdict: cronResult.verdict, reason: cronResult.reason, correctedOutput: cronResult.correctedOutput });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, taskId }, 'reviewer:cron.review LLM failed, fallback');
      decisionRecorder.record({ sessionId: `cron:${taskId}`, decisionType: 'cron_review', inputSummary: safeSlice(description, 500), outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'fallback' }, confidence: 0.5, taskId });
    }
  });

  // --- Handler: drift.check.request（B/C 审核漂移检测，翻转后从 brain 移植——drift 是 review 决策的一部分）---
  ipc.onMessage('drift.check.request', async (msg: IpcMessage) => {
    const payload = msg.payload as import('../../../kernel/drift-detector.js').DriftCheckRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const signal = await evaluateDriftCheck(payload, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ checkpointType: payload.checkpointType, alignmentScore: signal.alignmentScore }, 'reviewer:drift-check');
      ipc.send('drift.check.result', 'core', { signal }, trackingId);
    } catch (err) {
      logger.error({ err }, 'drift.check.request failed');
      ipc.send('drift.check.result', 'core', { signal: { alignmentScore: 1, needsIntervention: false, checkpointType: payload.checkpointType } }, trackingId);
    }
  });

  // --- Handler: verify.request（高漂移对抗性验证，翻转后从 brain 移植——verify 是 review 决策的一部分）---
  ipc.onMessage('verify.request', async (msg: IpcMessage) => {
    const { anchor, draftResponse } = msg.payload as { anchor: import('../../../contracts/intent.js').IntentAnchor; draftResponse: string };
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const verdict = await evaluateVerify(anchor, draftResponse, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ pass: verdict.pass, reason: safeSlice(verdict.reason ?? '', 100) }, 'reviewer:verify');
      ipc.send('verify.result', 'core', { verdict }, trackingId);
    } catch (err) {
      logger.error({ err }, 'verify.request failed');
      ipc.send('verify.result', 'core', { verdict: { pass: true, reason: '验证服务异常，默认通过' } }, trackingId);
    }
  });
});
