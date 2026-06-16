import { startResidentAgent } from '../../resident-agent.js';
import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { buildReviewSystemPrompt } from './review-prompt-builder.js';
import { evaluateCheckpoint } from './checkpoint-handler.js';
import { evaluateAskUser, evaluateSuperiorReview, evaluateDriftCheck, evaluateVerify } from './simple-handlers.js';
import { evaluatePermissionJudge } from './permission-handler.js';
import { evaluateRoute } from './route-handler.js';
import { evaluateCronReview } from './cron-review-handler.js';
import { evaluateReview } from './review-handler.js';
import { setupReviewFeedbackHandler } from './review-feedback-handler.js';
import { setupDialogueHandler } from './dialogue-handler.js';
import { createPlanMonitor } from './plan-monitor.js';
import { createCheckerDispatch } from './checker-dispatch.js';
import { setupObserveHandler } from './observe-handler.js';
import { createBrainHelpers } from './brain-helpers.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentManifest } from '../../manifest.js';
import type { ModelMessage } from '../../../contracts/model.js';
import type { ReviewResult, TurnRecord } from '../../../contracts/review.js';
import type { ToolBlock } from '../../../contracts/message-blocks.js';
import type { RouteResultPayload, PermissionJudgeResultPayload, AgentAskUserPayload } from '../../../contracts/routing.js';
import type { TurnCheckpointPayload, TurnCorrectionPayload } from '../../../contracts/delegation.js';
import { CORRECTION_LIMITS } from '../../../contracts/delegation.js';
import {
  buildReviewInput,
  buildRoutingSystemPrompt,
  buildRoutingUserPrompt,
  buildPermissionJudgeSystemPrompt,
  buildPermissionJudgeUserPrompt,
  buildAskUserReviewSystemPrompt,
  buildCheckpointSystemPrompt,
  buildCheckpointUserPrompt,
  buildSuperiorReviewSystemPrompt,
  buildSuperiorReviewUserPrompt,
  parseRouteDecision,
  parsePermissionJudge,
  parseAskUserReview,
  parseCheckpointResult,
  parseSuperiorReviewResult,
  buildCronReviewSystemPrompt,
  buildCronReviewUserPrompt,
  parseCronReviewResult,
} from './prompts.js';
import type { IpcMessage } from '../../../kernel/types.js';
import type { RouteRequestPayload, PermissionJudgeRequestPayload } from '../../../contracts/routing.js';
import type { SuperiorReviewRequest } from '../../../contracts/superior-review.js';
import { recallInsightsForDecision, formatInsightsBlock } from '../../../kernel/insights-recall.js';
import { markInsightAdoptedByDecision } from '../../../kernel/insights-lifecycle.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { ObservationRecorder, type RecordObservationInput, type ObservationType } from '../../../kernel/observation-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';
import { MissionManager } from '../../../kernel/mission-manager.js';
import { FallbackReviewer, type FallbackReviewInput } from '../../../kernel/fallback-reviewer.js';
import { genId } from '../../../utils/id.js';

const DEFAULT_PROMPT_A = `You are a Brain Agent performing a quick quality check on an AI assistant response.
You are given a SUMMARY of the conversation turn. Evaluate whether the draft response is appropriate.

Respond with valid JSON only:
{
  "verdict": "approve" | "modify" | "reject",
  "finalResponse": "corrected version if verdict is modify/reject",
  "reason": "brief explanation",
  "reRoute": null
}

Rules:
- "approve": the draft is appropriate and safe
- "modify": minor issues, provide a corrected version
- "reject": harmful or completely wrong, provide a safe alternative or set reRoute to redirect`;

const DEFAULT_PROMPT_BC = `You are a Brain Agent performing a thorough safety and quality review.
You are given the FULL conversation turn including tool calls and their results. Review carefully.

Respond with valid JSON only:
{
  "verdict": "approve" | "modify" | "reject",
  "finalResponse": "corrected version if verdict is modify/reject",
  "reason": "detailed explanation",
  "intentAlignment": "aligned" | "partial" | "misaligned",
  "reRoute": null
}

Rules:
- "approve": response is appropriate, tool usage is safe, no harmful patterns, intent aligned
- "modify": issues found but fixable — provide the corrected version
- "reject": harmful actions, data leaks, dangerous tool misuse, or completely misaligned intent — provide a safe alternative
- If rejecting because the wrong agent handled it, set "reRoute" to a RouteDecision object

Pay special attention to these review scenarios (13.0 §3.6):
- **A. Intent alignment**: Does the response directly answer the user's question? If it drifts (even if technically correct), mark intentAlignment "partial"/"misaligned" and consider "modify".
- **B. Scope creep / unauthorized changes**: User asked to change X, but agent also changed Y/Z. Keep correct parts, trim the rest in "modify".
- **C. Completely wrong direction**: User asked for a code change, agent wrote an explanation instead. "reject".
- **D. Security violation**: Dangerous tools (rm -rf, db_migrate), touched sensitive files (.env/config), or destructive ops without user confirmation. "reject".
- **E. Inter-agent dialogue issues**: Agent asked another agent too broadly and received/exposed excessive or sensitive data. "modify" (redact) + flag.
- **F. Efficiency problems**: Repeated tool calls (reading same file 3×, running same test 15×). Task done but wasteful → "approve" with a lesson note if the schema allows, else "modify".
- **G. Honesty / hallucination**: Response claims work that tool results contradict (e.g. "changed 5 files" but only 1 write_file recorded). "reject".
- **H. Ambiguous intent**: User intent unclear, agent guessed. "modify" — add a clarification prompt or caveat.
- **I. Delegation correctness**: Agent delegated a subtask to another agent and correctly integrated the result. Usually "approve".
- **J. Multi-path merge**: Multiple parallel agents' outputs merged — check for conflicts or contradictions in the merge. "approve" or "modify" to fix conflicts.

For each review, mentally scan all applicable scenarios and report the most severe issue found in "reason".`;

startResidentAgent(({ name, ipc, llm, db }) => {
  const logger = getLogger('brain');
  // Initialize prompt versioning for self-modification support
  const promptVersioning = new PromptVersioning(db);
  const decisionRecorder = new BrainDecisionRecorder(db);
  // 13.0 灵魂版：Brain 观察队列（OBSERVE 阶段零 LLM 持久化所有 Agent 间通信）
  const observationRecorder = new ObservationRecorder(db);
  // 13.0 多智能体协作：Mission / Plan / Squad 生命周期管理
  // OBSERVE 阶段定期读取 plan 监控进度，零 LLM（规则化判断）
  // 13.0 §12.6: Brain 用这个 MissionManager 实例在审核后自动 mark plan done/failed
  const missionManager = new MissionManager();
  // 13.0 §5.2.5: Brain 不可用/LLM 超时时的规则化降级审核器
  // 当 Brain LLM 调用失败时，FallbackReviewer 通过确定性规则（危险命令模式匹配、
  // 工具风险分类）提供最低限度安全审查，避免"LLM 挂了就全部自动批准"的风险
  const fallbackReviewer = new FallbackReviewer();

  /**
   * 用 FallbackReviewer 做规则化降级审核，映射到 ReviewResult。
   * LLM 调用失败 / 响应解析失败时统一走此路径，避免默认批准（违反"所有回复必须经 Brain 审核"硬规则）。
   *
   * @param turn 待审核的对话轮次（需要 draftResponse 和 toolCalls）
   * @param cause 降级原因（用于 reason 字段和日志追踪）
   */
  // buildFallbackReviewResult 提取到 brain-helpers.ts

  /**
   * session 级观察计数器，用于定期触发 plan 进度检查
   * key = sessionId, value = 自上次 plan check 以来的观察次数
   */
  const observationCounter = new Map<string, number>();
  /** 每 N 次观察触发一次 plan check（§12.5） */
  const PLAN_CHECK_INTERVAL = 5;
  /** 任务 working 状态超过该毫秒数视为"卡住" */
  const { checkPlanProgress } = createPlanMonitor({ missionManager, observationRecorder, decisionRecorder, ipc });

  /** brain.observe IPC handler 载荷（Kernel 转发来的观察事件） */
  interface BrainObservePayload {
    sessionId: string;
    taskId: string;
    observationType: ObservationType;
    fromAgent: string;
    toAgent?: string;
    content: string;
    priority?: 0 | 1 | 2;
    metadata?: Record<string, unknown>;
  }

  /**
   * 13.0 灵魂版 brain.observe handler：零 LLM 持久化观察。
   * Brain 三段式工作模型（OBSERVE / INTERVENE / REVIEW）的 OBSERVE 阶段入口。
   * 现有 IPC 推送（dialogue.observe）继续生效，此 handler 是新增的持久化路径。
   *
   * §12.5: 每 PLAN_CHECK_INTERVAL 次观察后触发一次 plan 进度检查（零 LLM）。
   * 如果发现 working 状态的任务长时间未更新（updated_at 超过 TASK_STALLED_MS），
   * 记录一条 agent_event 类型观察"plan_stalled: task X"——后续 C 级审核时 LLM 可见。
   */
  setupObserveHandler({ observationRecorder, checkPlanProgress, ipc });

  // recallDecisionsBlock / getReviewPrompt / getRoutingPrompt / getPermissionPrompt /
  // acquireReviewSlot / releaseReviewSlot 全部提取到 brain-helpers.ts
  const { recallDecisionsBlock, getReviewPrompt, getRoutingPrompt, getPermissionPrompt, buildFallbackReviewResult, acquireReviewSlot, releaseReviewSlot } = createBrainHelpers({ decisionRecorder, promptVersioning, fallbackReviewer, name, defaultPromptA: DEFAULT_PROMPT_A, defaultPromptBc: DEFAULT_PROMPT_BC });

  // --- Handler 1: review.request (existing, enhanced with reRoute + concurrency control) ---

  ipc.onMessage('review.request', async (msg: IpcMessage) => {
    // §5.2.5: 并发审核准入控制 — 等待获取审核 slot
    await acquireReviewSlot();
    try {
    const { turn } = msg.payload as { turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: ToolBlock[]; level: 'A' | 'B' | 'C'; missionId?: string; planTaskId?: string; taskDescription?: string; boardTaskId?: string } };
    const trackingId = msg.correlationId ?? msg.id;
    // §17.4 续 + ①② 第1步：review systemPrompt 构造已提取到 review-prompt-builder.ts
    // （worldModel/观察队列/板上下文/insights/mission/历史决策/uncertain 6段注入，行为保持）。
    const systemPrompt = buildReviewSystemPrompt(turn, {
      db, observationRecorder, missionManager,
      getBasePrompt: getReviewPrompt,
      recallDecisionsBlock,
    });

    try {
      // 核心逻辑提取到 review-handler.ts（§17.4 巨石拆解，review.request 最大单块提取）
      const reviewResult = await evaluateReview(turn as TurnRecord, systemPrompt, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId, buildFallbackReviewResult);

      logger.debug({ level: turn.level, verdict: reviewResult.verdict, reason: safeSlice(reviewResult.reason, 200), hasReRoute: !!reviewResult.reRoute, draftLen: turn.draftResponse?.length }, 'brain:review');

      // 13.0 P10: 派发独立 checker 审核（仅当 squad 里有 check 角色成员时）
      // 不阻塞主 review.result — checker 的 verdict 通过 brain.signal_intervention 事件异步影响后续 plan
      if (turn.planTaskId && turn.missionId) {
        dispatchCheckerReview(turn.missionId, turn.planTaskId, turn, reviewResult, trackingId);
      }

      ipc.send('review.result', 'core', reviewResult, trackingId);

      // 13.0 §12: 记录审核决策到 BrainDecisionRecorder（供后续进化反馈 + lesson 学习）
      // 自动对 verdict 做敏感数据脱敏（§3.6 场景 E）
      decisionRecorder.recordReviewDecision(
        turn.sessionId,
        turn.draftResponse ?? turn.userMessage,
        reviewResult as unknown as Record<string, unknown>,
        turn.planTaskId ?? trackingId,
      );

      // 13.0 §12.6: 审核完成后自动 mark plan task done/failed（不阻塞审核主流程）
      // approve → done；modify → done（带修改后的结果）；reject → failed
      if (turn.planTaskId && turn.missionId) {
        try {
          const isApprove = reviewResult.verdict === 'approve';
          const isModify = reviewResult.verdict === 'modify';
          const isReject = reviewResult.verdict === 'reject';
          if (isApprove || isModify) {
            const resultText = reviewResult.finalResponse ?? reviewResult.reason ?? '审核通过';
            missionManager.updatePlan(turn.missionId, {
              task_id: turn.planTaskId,
              status: 'done',
              result: resultText.slice(0, 2000),
            });
            logger.debug({ missionId: turn.missionId, planTaskId: turn.planTaskId, verdict: reviewResult.verdict }, 'brain:review auto-marked plan task done');
          } else if (isReject) {
            missionManager.updatePlan(turn.missionId, {
              task_id: turn.planTaskId,
              status: 'failed',
              result: (reviewResult.reason ?? '审核拒绝').slice(0, 2000),
            });
            logger.debug({ missionId: turn.missionId, planTaskId: turn.planTaskId, verdict: reviewResult.verdict }, 'brain:review auto-marked plan task failed');
          }
        } catch (planErr) {
          // plan 更新失败不阻塞审核主流程 — 记录 warn 让运维追查
          logger.warn({ err: planErr, missionId: turn.missionId, planTaskId: turn.planTaskId }, 'brain:review plan auto-update failed');
        }
      }
    } catch (err) {
      // 13.0 §5.2.5 失败降级：Brain LLM 不可用时用 FallbackReviewer 做规则化审查
      // 不再"批准一切"——用确定性规则（危险命令模式、工具风险分类）兜底
      logger.warn({ err: (err as Error).message }, 'brain:review LLM call failed, falling back to FallbackReviewer');

      const fallbackReviewResult = buildFallbackReviewResult(turn, 'Brain LLM 不可用');
      const verdict = fallbackReviewResult.verdict;
      const reason = fallbackReviewResult.reason;
      ipc.send('review.result', 'core', fallbackReviewResult, trackingId);

      // 13.0 §12.6 + §13.21: 降级审核也必须标记 plan task，否则 LLM 不可用时
      // plan task 永不 done/failed → 级联失效 → mission 挂起（与主审核路径一致）
      if (turn.planTaskId && turn.missionId) {
        try {
          const isApprove = verdict === 'approve';
          const isModify = verdict === 'modify';
          if (isApprove || isModify) {
            missionManager.updatePlan(turn.missionId, {
              task_id: turn.planTaskId,
              status: 'done',
              result: (reason ?? '降级审核通过').slice(0, 2000),
            });
          } else {
            missionManager.updatePlan(turn.missionId, {
              task_id: turn.planTaskId,
              status: 'failed',
              result: (reason ?? '降级审核拒绝').slice(0, 2000),
            });
          }
        } catch (planErr) {
          logger.warn({ err: planErr, missionId: turn.missionId, planTaskId: turn.planTaskId }, 'brain:fallback review plan auto-update failed');
        }
      }
    }
    } finally {
      // §5.2.5: 释放审核 slot，唤醒下一个排队者
      releaseReviewSlot();
    }
  });

  // ─── 13.0 §8.6 + §3.1 提示能力: 自我审核反馈 IPC + prompt 自修改闭环 ───
  // 让前端 / Evolution Engine 把 lesson 写回 brain_decisions，
  // 并在 lessons 累积到阈值时自动通过 PromptVersioning.propose() 生成新 prompt 版本。
  // 设计依据：
  //   - §3.1 "提示"能力：给 agent 建议和引导，让它们越做越好
  //   - §8.8: Brain 高 severity 纠偏升级为跨 session 偏好
  //   - §3.9: 软纠偏通过 StateCache 行为注释跨 task 持久
  // §17.4 巨石拆解：brain.review.feedback 整组提取到 review-feedback-handler.ts
  setupReviewFeedbackHandler({ db, decisionRecorder, promptVersioning, ipc, defaultPromptA: DEFAULT_PROMPT_A, defaultPromptBc: DEFAULT_PROMPT_BC });

  const dispatchCheckerReview = createCheckerDispatch({ missionManager, decisionRecorder, ipc });

  // --- Handler 2: route.request (LLM 调用提取到 route-handler.ts，§17.4) ---

  ipc.onMessage('route.request', async (msg: IpcMessage) => {
    const payload = msg.payload as RouteRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;

    // systemPrompt 构造（含 recallInsights/recallDecisions/mission 上下文/升级指令 闭包，留在 entry.ts）
    let systemPrompt = getRoutingPrompt();
    const insights = recallInsightsForDecision(db, 'route', 5);
    if (insights.length > 0) {
      systemPrompt += formatInsightsBlock(insights);
      markInsightAdoptedByDecision(db, 'route', insights.map(i => i.id));
    }
    systemPrompt += recallDecisionsBlock('route');
    try {
      const activeMissions = missionManager.listMissions().filter(m => m.status === 'in_progress').slice(0, 3);
      if (activeMissions.length > 0) {
        systemPrompt += `\n\n## 当前活跃 Mission（供路由参考）\n${activeMissions.map(m => `- ${m.id}（${m.goal}）进度: ${m.taskCount} 个任务`).join('\n')}`;
      }
    } catch (missionErr) { logger.debug({ err: missionErr }, 'brain:route mission context skipped'); }
    systemPrompt += `\n\n## 拿不准时升级（uncertain）\n绝大多数情况你能明确判断 intent + targetAgent。仅当用户意图严重歧义、多个 Agent 都看似相关且误路由代价高时，额外返回 "uncertain": true 与 "escalationQuestion"，系统会把问题转给用户而非猜测路由。能判断就正常输出 intent/targetAgent，不要滥用。`;

    try {
      const decision = await evaluateRoute(payload, systemPrompt, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ intent: decision.intent, target: decision.targetAgent, reason: safeSlice(decision.reason, 200) }, 'brain:route');
      // missionSpec → createMission
      if (decision.missionSpec && decision.missionSpec.goal && decision.missionSpec.tasks.length > 0) {
        try {
          const plan = missionManager.createMission(decision.missionSpec.goal, decision.missionSpec.context ?? payload.message, decision.missionSpec.tasks);
          decision.missionId = plan.mission.id;
          logger.info({ missionId: plan.mission.id, goal: decision.missionSpec.goal }, 'brain:route mission created');
        } catch (missionErr) { logger.warn({ err: missionErr }, 'brain:route mission creation failed'); }
      }
      ipc.send('route.result', 'core', { decision, escalation: decision.escalation } satisfies RouteResultPayload, trackingId);
      decisionRecorder.recordRouteDecision(payload.sessionId, payload.message, { ...decision, missionId: decision.missionId }, payload.taskId);
    } catch (err) {
      ipc.send('route.result', 'core', { decision: { intent: 'chat', targetAgent: 'conversation', priority: 'normal', reason: `路由 LLM 失败: ${(err as Error).message}` } } satisfies RouteResultPayload, trackingId);
    }
  });

  // --- Handler 3: permission.judge (LLM 调用提取到 permission-handler.ts，§17.4) ---

  ipc.onMessage('permission.judge', async (msg: IpcMessage) => {
    const payload = msg.payload as PermissionJudgeRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;

    // systemPrompt 构造（含 recallInsights/recallDecisions 闭包，留在 entry.ts）
    let systemPrompt = getPermissionPrompt();
    const permInsights = recallInsightsForDecision(db, 'permission', 3);
    if (permInsights.length > 0) {
      systemPrompt += formatInsightsBlock(permInsights);
      markInsightAdoptedByDecision(db, 'permission', permInsights.map(i => i.id));
    }
    systemPrompt += recallDecisionsBlock('permission');

    try {
      const judgment = await evaluatePermissionJudge(payload, systemPrompt, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ tool: payload.toolName, allowed: judgment.allowed, reason: safeSlice(judgment.reason, 200) }, 'brain:permission');
      ipc.send('permission.judge.result', 'core', judgment as PermissionJudgeResultPayload, trackingId);
      decisionRecorder.recordPermissionDecision(payload.sessionId, payload.toolName, judgment as unknown as Record<string, unknown>);
    } catch (err) {
      ipc.send('permission.judge.result', 'core', { allowed: false, reason: `权限判断 LLM 失败: ${(err as Error).message}` } satisfies PermissionJudgeResultPayload, trackingId);
    }
  });

  // --- Handler 4: agent.ask_user (核心逻辑提取到 simple-handlers.ts，§17.4) ---

  ipc.onMessage('agent.ask_user', async (msg: IpcMessage) => {
    const payload = msg.payload as AgentAskUserPayload;
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const review = await evaluateAskUser(payload, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      ipc.send('agent.ask_user', 'core', { ...payload, _brainReview: review }, trackingId);
    } catch {
      ipc.send('agent.ask_user', 'core', { ...payload, _brainReview: { approved: true } }, trackingId);
    }
  });

  // --- Handler 5: checkpoint.evaluate (Layer 3 semantic correction) ---
  // 核心逻辑提取到 brain/checkpoint-handler.ts（§17.4 巨石拆解），entry.ts 保留 ipc 薄包装。

  ipc.onMessage('checkpoint.evaluate', async (msg: IpcMessage) => {
    const payload = msg.payload as TurnCheckpointPayload;
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const correction = await evaluateCheckpoint(
        payload,
        (messages, options) => llm.current.chat(messages, options as Parameters<typeof llm.current.chat>[1]),
        name,
        trackingId,
      );
      // 15.0 机制 D：checkpoint 阶段 Brain 顺带发号施令（command 伴随字段）。
      if (correction.command) {
        ipc.send('brain.command', 'core', correction.command, trackingId);
      }
      ipc.send('checkpoint.evaluate.result', 'core', correction, trackingId);
    } catch {
      ipc.send('checkpoint.evaluate.result', 'core', {
        delegationId: payload.delegationId,
        action: 'continue',
      } satisfies TurnCorrectionPayload, trackingId);
    }
  });

  // --- Handler 6: superior.review.request (核心逻辑提取到 simple-handlers.ts，§17.4) ---

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

  // ─── 11.0: dialogue.observe — 异步监听智能体间对话 ───
  setupDialogueHandler({ ipc, llm, name });

  // ─── 12.0: drift.check.request (核心逻辑提取到 simple-handlers.ts，§17.4) ───
  ipc.onMessage('drift.check.request', async (msg: IpcMessage) => {
    const payload = msg.payload as import('../../../kernel/drift-detector.js').DriftCheckRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const signal = await evaluateDriftCheck(payload, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ checkpointType: payload.checkpointType, alignmentScore: signal.alignmentScore }, 'brain:drift-check');
      ipc.send('drift.check.result', 'core', { signal }, trackingId);
    } catch (err) {
      logger.error({ err }, 'drift.check.request failed');
      ipc.send('drift.check.result', 'core', { signal: { alignmentScore: 1, needsIntervention: false, checkpointType: payload.checkpointType } }, trackingId);
    }
  });

  // ─── 12.0: verify.request (核心逻辑提取到 simple-handlers.ts，§17.4) ───
  ipc.onMessage('verify.request', async (msg: IpcMessage) => {
    const { anchor, draftResponse } = msg.payload as { anchor: import('../../../contracts/intent.js').IntentAnchor; draftResponse: string };
    const trackingId = msg.correlationId ?? msg.id;
    try {
      const verdict = await evaluateVerify(anchor, draftResponse, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, trackingId);
      logger.debug({ pass: verdict.pass, reason: safeSlice(verdict.reason ?? '', 100) }, 'brain:verify');
      ipc.send('verify.result', 'core', { verdict }, trackingId);
    } catch (err) {
      logger.error({ err }, 'verify.request failed');
      ipc.send('verify.result', 'core', { verdict: { pass: true, reason: '验证服务异常，默认通过' } }, trackingId);
    }
  });

  // ─── 13.0 §13.8: cron 任务审核（LLM + 规则双路径） ───
  // cron.review 由 CronScheduler 在 core 进程发出，经 IPC 边界中继到 Brain 子进程。
  // 策略：输出短/简单 → 规则化快速通过；输出长/复杂 → LLM 审核
  // 注意：Brain 是独立子进程，EventBus 是进程内的——必须用 ipc.onMessage 接收，
  // 而非 getEventBus().on()（后者会因 EventBus 未初始化直接崩，且跨进程也收不到）。
  ipc.onMessage('cron.review', async (msg: IpcMessage) => {
    const payload = msg.payload as { taskId: string; description: string; output: string; createdAt: number };
    const { taskId, description, output } = payload;
    const outputLen = output?.length ?? 0;
    const descLen = description?.length ?? 0;
    logger.info({ taskId, descriptionLen: descLen, outputLen }, 'brain:cron.review received');

    /** 判断是否需要 LLM 审核（基于输出复杂度和长度） */
    const needsLlmReview = outputLen > 2000 || descLen > 100;
    /** 快速判定：输出短且无描述时直接规则化通过 */
    const quickApprove = !needsLlmReview && outputLen <= 500;

    if (quickApprove) {
      // ── 快速规则化通过（零 LLM） ──
      decisionRecorder.record({
        sessionId: `cron:${taskId}`,
        decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'rule_quick' },
        confidence: 0.9,
        taskId,
      });
      logger.debug({ taskId, outputLen }, 'brain:cron.review quick-approved (rule-based, short output)');
      return;
    }

    if (!needsLlmReview) {
      // ── 中等输出，规则化通过但置信度较低 ──
      decisionRecorder.record({
        sessionId: `cron:${taskId}`,
        decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'rule_medium' },
        confidence: 0.7,
        taskId,
      });
      logger.debug({ taskId, outputLen }, 'brain:cron.review auto-approved (rule-based, medium output)');
      return;
    }

    // ── 复杂/长输出：调用 LLM 审核（核心逻辑提取到 cron-review-handler.ts，§17.4） ──
    try {
      const cronResult = await evaluateCronReview(description ?? '', output, (m, o) => llm.current.chat(m, o as Parameters<typeof llm.current.chat>[1]), name, taskId);
      logger.info({ taskId, verdict: cronResult.verdict, confidence: cronResult.confidence, reason: safeSlice(cronResult.reason, 200) }, 'brain:cron.review LLM verdict');
      decisionRecorder.record({
        sessionId: `cron:${taskId}`, decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: { output: safeSlice(output, 2000), autoApproved: cronResult.verdict === 'approve', llmVerdict: cronResult.verdict, llmReason: safeSlice(cronResult.reason, 500), correctedOutput: cronResult.correctedOutput ? safeSlice(cronResult.correctedOutput, 1000) : undefined, path: 'llm' },
        confidence: cronResult.confidence, taskId,
      });
      if (cronResult.verdict !== 'approve') {
        ipc.send('brain.cron_review_flagged', 'core', { taskId, verdict: cronResult.verdict, reason: cronResult.reason, correctedOutput: cronResult.correctedOutput });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, taskId }, 'brain:cron.review LLM failed, fallback');
      decisionRecorder.record({ sessionId: `cron:${taskId}`, decisionType: 'cron_review', inputSummary: safeSlice(description, 500), outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'fallback' }, confidence: 0.5, taskId });
    }
  });
});
