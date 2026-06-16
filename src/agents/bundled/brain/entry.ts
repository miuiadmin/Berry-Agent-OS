import { startResidentAgent } from '../../resident-agent.js';
import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { evaluateCheckpoint } from './checkpoint-handler.js';
import { evaluateAskUser } from './simple-handlers.js';
import { evaluatePermissionJudge } from './permission-handler.js';
import { evaluateRoute } from './route-handler.js';
import { setupDialogueHandler } from './dialogue-handler.js';
import { createPlanMonitor } from './plan-monitor.js';
import { setupObserveHandler } from './observe-handler.js';
import { createBrainHelpers } from './brain-helpers.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentManifest } from '../../manifest.js';
import type { ModelMessage } from '../../../contracts/model.js';
import type { RouteResultPayload, PermissionJudgeResultPayload, AgentAskUserPayload } from '../../../contracts/routing.js';
import type { TurnCheckpointPayload, TurnCorrectionPayload } from '../../../contracts/delegation.js';
import { CORRECTION_LIMITS } from '../../../contracts/delegation.js';
import {
  DEFAULT_REVIEW_PROMPT_A as DEFAULT_PROMPT_A,
  DEFAULT_REVIEW_PROMPT_BC as DEFAULT_PROMPT_BC,
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
import { recallInsightsForDecision, formatInsightsBlock } from '../../../kernel/insights-recall.js';
import { markInsightAdoptedByDecision } from '../../../kernel/insights-lifecycle.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { ObservationRecorder, type RecordObservationInput, type ObservationType } from '../../../kernel/observation-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';
import { MissionManager } from '../../../kernel/mission-manager.js';
import { FallbackReviewer, type FallbackReviewInput } from '../../../kernel/fallback-reviewer.js';
import { genId } from '../../../utils/id.js';

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

  // ①②：review 拆给 ②reviewer 后，brain 只用 routing/permission 相关 helper（recallDecisionsBlock/getRoutingPrompt/getPermissionPrompt）
  const { recallDecisionsBlock, getRoutingPrompt, getPermissionPrompt } = createBrainHelpers({ decisionRecorder, promptVersioning, fallbackReviewer, name, defaultPromptA: DEFAULT_PROMPT_A, defaultPromptBc: DEFAULT_PROMPT_BC });

  // ①② 议会拆分：review 职能已拆给 ②reviewer agent。brain 不再处理 review——
  // review.request / review.feedback / checker dispatch / cron.review / superior.review.request
  // / drift.check.request / verify.request 全由 ②reviewer 接管（见 src/agents/bundled/reviewer/）。
  // brain 现是纯 orchestrator（routing/permission/command/observe/ask/correction）。

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

  // ─── 11.0: dialogue.observe — 异步监听智能体间对话（brain orchestrator 职能，保留）───
  setupDialogueHandler({ ipc, llm, name });
});
