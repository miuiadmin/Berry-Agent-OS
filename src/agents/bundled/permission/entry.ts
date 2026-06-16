/**
 * ①permission agent 进程入口（架构升级 16.0 §4.0 议会拆分）—— 权限专员。
 *
 * 从 brain 拆出的独立权限 agent。复用 brain 已提取的 permission 纯资产（evaluatePermissionJudge +
 * createBrainHelpers.getPermissionPrompt/recallDecisionsBlock）。审核核心在 produce-permission.ts（可单测）。
 * 行为等价 brain 原 permission.judge handler。IPC + capability-bus 双路径都经 permission-flow 汇聚到
 * requireRole('permission') → 本 agent。
 */

import { startResidentAgent } from '../../resident-agent.js';
import type { IpcMessage } from '../../../kernel/types.js';
import type { PermissionJudgeRequestPayload, PermissionJudgeResultPayload } from '../../../contracts/routing.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';
import { FallbackReviewer } from '../../../kernel/fallback-reviewer.js';
import { DEFAULT_REVIEW_PROMPT_A, DEFAULT_REVIEW_PROMPT_BC } from '../brain/prompts.js';
import { createBrainHelpers } from '../brain/brain-helpers.js';
import { producePermissionJudge, type PermissionJudgeContext } from './produce-permission.js';

startResidentAgent(({ name, ipc, llm, db }) => {
  const promptVersioning = new PromptVersioning(db);
  const decisionRecorder = new BrainDecisionRecorder(db);
  const fallbackReviewer = new FallbackReviewer();

  // 复用 brain helper 工厂，只用 permission 相关（getPermissionPrompt/recallDecisionsBlock）
  const { recallDecisionsBlock, getPermissionPrompt } = createBrainHelpers({ decisionRecorder, promptVersioning, fallbackReviewer, name, defaultPromptA: DEFAULT_REVIEW_PROMPT_A, defaultPromptBc: DEFAULT_REVIEW_PROMPT_BC });

  const ctx: PermissionJudgeContext = {
    db,
    getPermissionPrompt,
    recallDecisionsBlock,
    recordPermissionDecision: (sessionId, toolName, judgment) => decisionRecorder.recordPermissionDecision(sessionId, toolName, judgment),
  };

  // --- Handler: permission.judge（行为等价 brain 原 handler）---
  ipc.onMessage('permission.judge', async (msg: IpcMessage) => {
    const payload = msg.payload as PermissionJudgeRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;
    const judgment = await producePermissionJudge(
      payload,
      trackingId,
      (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]),
      ctx,
      name,
    );
    ipc.send('permission.judge.result', 'core', judgment satisfies PermissionJudgeResultPayload, trackingId);
  });
});
