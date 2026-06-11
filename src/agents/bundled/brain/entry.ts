import { startResidentAgent } from '../../resident-agent.js';
import { getLogger } from '../../../utils/logger.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentManifest } from '../../manifest.js';
import type { ModelMessage } from '../../../contracts/model.js';
import type { ReviewResult } from '../../../contracts/review.js';
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
import { getEventBus } from '../../../kernel/event-bus.js';
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

function getWorldModelSummary(db: import('better-sqlite3').Database): string {
  try {
    const row = db.prepare(`SELECT snapshot_json FROM world_model WHERE id = 'current'`).get() as { snapshot_json: string } | undefined;
    if (!row) return '';
    const snapshot = JSON.parse(row.snapshot_json);
    const parts: string[] = [];
    if (snapshot.user?.currentActivity) parts.push(`活动: ${snapshot.user.currentActivity}`);
    if (snapshot.user?.energyLevel && snapshot.user.energyLevel !== 'unknown') parts.push(`精力: ${snapshot.user.energyLevel}`);
    if (snapshot.user?.frustrationSignals > 2) parts.push(`注意: 挫败感信号(${snapshot.user.frustrationSignals})`);
    if (snapshot.temporal?.upcomingDeadlines?.length > 0) {
      const d = snapshot.temporal.upcomingDeadlines[0];
      parts.push(`deadline: ${d.description}`);
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}

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
   * session 级观察计数器，用于定期触发 plan 进度检查
   * key = sessionId, value = 自上次 plan check 以来的观察次数
   */
  const observationCounter = new Map<string, number>();
  /** 每 N 次观察触发一次 plan check（§12.5） */
  const PLAN_CHECK_INTERVAL = 5;
  /** 任务 working 状态超过该毫秒数视为"卡住" */
  const TASK_STALLED_MS = 5 * 60 * 1000;

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
  ipc.onMessage('brain.observe', (msg: IpcMessage) => {
    const payload = msg.payload as BrainObservePayload;
    try {
      const recordInput: RecordObservationInput = {
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        observationType: payload.observationType,
        fromAgent: payload.fromAgent,
        toAgent: payload.toAgent,
        content: safeSlice(payload.content, 2000),
        priority: payload.priority ?? 1,
        metadata: payload.metadata,
      };
      observationRecorder.record(recordInput);
    } catch (err) {
      // 观察记录失败不应阻塞其他业务
      logger.warn({ err, sessionId: payload.sessionId, taskId: payload.taskId }, 'brain.observe:record failed');
    }

    // §12.5 定期 plan 进度检查（零 LLM，规则化）
    try {
      const count = (observationCounter.get(payload.sessionId) ?? 0) + 1;
      observationCounter.set(payload.sessionId, count);
      if (count >= PLAN_CHECK_INTERVAL) {
        observationCounter.set(payload.sessionId, 0);
        checkPlanProgress(payload.sessionId, payload.taskId);
      }
    } catch (err) {
      logger.warn({ err, sessionId: payload.sessionId }, 'brain.observe:plan-check failed');
    }
  });

  /**
   * 检查指定 session 的活跃 mission 进度，识别卡住的任务。
   * 规则：working 状态的 task 如果 updated_at 超过 TASK_STALLED_MS，视为卡住。
   * 该信号以 agent_event 类型观察形式记录，不消耗 LLM——LLM 只在 C 级审核时看到。
   *
   * @param sessionId 触发检查的 session
   * @param taskId 触发检查的 task（仅用于上下文标记，不影响匹配逻辑）
   */
  function checkPlanProgress(sessionId: string, taskId: string): void {
    const missions = missionManager.listMissions();
    if (missions.length === 0) return;

    const now = Date.now();
    for (const m of missions) {
      // 只检查 in_progress 的 mission
      if (m.status !== 'in_progress') continue;
      const plan = missionManager.readPlan(m.id);
      if (!plan) continue;

      for (const task of plan.tasks) {
        if (task.status !== 'working') continue;
        // updated_at 在 schema 中是 optional，没设过则视为新任务不卡住
        if (!task.updated_at) continue;
        const updated = new Date(task.updated_at).getTime();
        const elapsed = now - updated;
        if (elapsed < TASK_STALLED_MS) continue;

        // 任务卡住 → 记录 stall 观察（供后续 C 级审核 LLM 参考）
        const signal = `plan_stalled: task ${task.id} (${task.what}) working for ${Math.round(elapsed / 1000)}s`;
        observationRecorder.record({
          sessionId,
          taskId,
          observationType: 'agent_event',
          fromAgent: 'brain',
          toAgent: task.who,
          content: signal,
          priority: 0, // critical — 不被滚动窗口丢弃
        });
        logger.info({ sessionId, missionId: m.id, taskId: task.id, elapsedMs: elapsed }, 'brain:plan_stalled');
      }

      // P9: 检查 squad 信号 — blocker / question 触发干预
      const squad = missionManager.readSquad(m.id);
      if (squad) {
        const unresolvedSignals = squad.signals.filter(s =>
          (s.type === 'blocker' || s.type === 'question') && !s.resolved,
        );
        for (const sig of unresolvedSignals.slice(0, 3)) {
          const content = `squad_signal: [${sig.type}] ${sig.from}: ${sig.msg}`;
          observationRecorder.record({
            sessionId,
            taskId,
            observationType: 'agent_event',
            fromAgent: 'brain',
            toAgent: sig.from,
            content,
            priority: 0, // critical — blocker/question 必须被看到
          });
          logger.info({ sessionId, missionId: m.id, signalType: sig.type, from: sig.from }, 'brain:squad_signal_observed');

          // P9 §12.5: 触发 INTERVENE — 找到 sig.from 所在 squad 的 worker，
          // 通过 EventBus 发 brain.signal_intervention 事件，附带软纠偏 instruction
          triggerSignalIntervention(m.id, sig, sessionId);
        }
      }
    }
  }

  /**
   * P9: 根据 blocker/question signal 触发 INTERVENE（规则化、零 LLM）。
   *
   * 冷却机制：同 (missionId, signal.from, signal.msg) 在 5 分钟内只触发一次，
   * 避免重复干预造成 worker 分心。
   *
   * 事件订阅者可以做后续动作（如：kernel 路由 turn.correction 给 worker，
   * 或 evolution 引擎把常见 blocker 沉淀为 SKILL.md）。
   */
  const signalInterventionCooldown = new Map<string, number>();
  const SIGNAL_INTERVENTION_COOLDOWN_MS = 5 * 60_000;

  function triggerSignalIntervention(
    missionId: string,
    signal: { from: string; type: string; msg: string; at: string },
    sessionIdRef: string,
  ): void {
    const cooldownKey = `${missionId}:${signal.from}:${signal.msg}`;
    const now = Date.now();
    const lastAt = signalInterventionCooldown.get(cooldownKey) ?? 0;
    if (now - lastAt < SIGNAL_INTERVENTION_COOLDOWN_MS) return;
    signalInterventionCooldown.set(cooldownKey, now);

    // 模板化 instruction：告诉 worker 当前信号是什么 + 建议行动
    const instruction = signal.type === 'blocker'
      ? `检测到 blocker 信号（来自 ${signal.from}）：${signal.msg.slice(0, 300)}。请评估是否需要调整方案、回报用户，或请 leader 协助。`
      : `检测到 question 信号（来自 ${signal.from}）：${signal.msg.slice(0, 300)}。请尽快回应，避免阻塞下游 squad。`;

    // 记录决策（供审计和 evolution 学习）
    try {
      decisionRecorder.record({
        sessionId: sessionIdRef,
        decisionType: 'correction',
        inputSummary: `squad_signal:[${signal.type}] ${signal.from} in ${missionId}`,
        outputJson: {
          action: 'adjust',
          reason: `p9_signal_intervention:${signal.type}`,
          instruction: instruction.slice(0, 500),
          target: signal.from,
          missionId,
        },
      });
    } catch (err) {
      logger.warn({ err, missionId, signalType: signal.type }, 'brain: signal intervention decision record failed');
    }

    // 发 EventBus 事件（kernel 可订阅后路由 turn.correction 给 worker）
    getEventBus().emit('brain.signal_intervention', {
      missionId,
      from: signal.from,
      signalType: signal.type,
      signalMsg: signal.msg,
      instruction,
      severity: signal.type === 'blocker' ? 'high' : 'medium',
      createdAt: now,
    });
    logger.info({
      missionId,
      from: signal.from,
      signalType: signal.type,
    }, 'brain:signal_intervention triggered');
  }

  function recallDecisionsBlock(decisionType: string): string {
    const decisions = decisionRecorder.recallForDecision(decisionType, 5);
    if (decisions.length === 0) return '';
    const lines = decisions.map(d => {
      const outcome = d.outcome ? ` [${d.outcome}]` : '';
      const lesson = d.lesson ? ` 教训: ${d.lesson}` : '';
      return `- ${safeSlice(d.inputSummary, 80)}${outcome}${lesson}`;
    });
    return `\n\n## 历史决策参考\n\n${lines.join('\n')}\n`;
  }

  function getReviewPrompt(level: 'A' | 'B' | 'C'): string {
    const key = level === 'A' ? 'brain.review.a' : 'brain.review.bc';
    const versioned = promptVersioning.getActiveVersion(key);
    return versioned?.content ?? (level === 'A' ? DEFAULT_PROMPT_A : DEFAULT_PROMPT_BC);
  }

  function getRoutingPrompt(): string {
    const versioned = promptVersioning.getActiveVersion('brain.routing');
    return versioned?.content ?? buildRoutingSystemPrompt();
  }

  function getPermissionPrompt(): string {
    const versioned = promptVersioning.getActiveVersion('brain.permission');
    return versioned?.content ?? buildPermissionJudgeSystemPrompt();
  }

  // ─── §5.2.5: Brain 并发审核准入控制 ───
  // 限制同时进行的 LLM 审核数量（默认 5），防止：
  //   1. Brain LLM 不可用时 FallbackReviewer 被雷群效应压垮
  //   2. 多个 review 同时争抢 LLM token 配额
  //   3. 内存暴涨（每个审核都构建完整 context）
  const MAX_CONCURRENT_REVIEWS = 5;
  /** 当前正在执行的审核数 */
  let activeReviewCount = 0;
  /** 等待审核的队列（先进先出） */
  const reviewQueue: Array<{ msg: IpcMessage; resolve: () => void }> = [];

  /** 获取审核许可（排队等待） */
  function acquireReviewSlot(): Promise<void> {
    if (activeReviewCount < MAX_CONCURRENT_REVIEWS) {
      activeReviewCount++;
      return Promise.resolve();
    }
    // 超出并发上限，排队等待
    return new Promise<void>((resolve) => {
      reviewQueue.push({ msg: null as unknown as IpcMessage, resolve });
      logger.debug({
        activeCount: activeReviewCount,
        queueLength: reviewQueue.length,
      }, 'brain:review queued (concurrency limit)');
    });
  }

  /** 释放审核许可（唤醒下一个排队的） */
  function releaseReviewSlot(): void {
    activeReviewCount = Math.max(0, activeReviewCount - 1);
    if (reviewQueue.length > 0) {
      const next = reviewQueue.shift()!;
      activeReviewCount++;
      next.resolve();
    }
  }

  // --- Handler 1: review.request (existing, enhanced with reRoute + concurrency control) ---

  ipc.onMessage('review.request', async (msg: IpcMessage) => {
    // §5.2.5: 并发审核准入控制 — 等待获取审核 slot
    await acquireReviewSlot();
    try {
    const { turn } = msg.payload as { turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: Array<{ name: string; input: string; result: string }>; level: 'A' | 'B' | 'C'; missionId?: string; planTaskId?: string; taskDescription?: string } };
    const trackingId = msg.correlationId ?? msg.id;
    let systemPrompt = getReviewPrompt(turn.level);

    // Inject World Model context for review decisions
    const worldSummary = getWorldModelSummary(db);
    if (worldSummary) {
      systemPrompt += `\n\n[World State] ${worldSummary}`;
    }

    // 13.0 灵魂版：C 级审核注入观察队列上下文，提供完整 Agent 行为时间线
    // 设计依据：§20.7 后置审核增强 — C 级使用完整 observation queue
    // M1 保真度：若观察队列被截断（窗口裁剪），追加警告降低审核置信度
    if (turn.level === 'C' && turn.sessionId) {
      const observations = observationRecorder.queryByType(
        turn.sessionId,
        ['dialogue_send', 'dialogue_reply', 'tool_call', 'tool_result', 'drift_signal'],
        20,
      );
      if (observations.length > 0) {
        const observationContext = observations
          .map(o => `[${o.observationType}] ${o.fromAgent}${o.toAgent ? '→' + o.toAgent : ''}: ${safeSlice(o.content, 200)}`)
          .join('\n');
        systemPrompt += `\n\n## 近期 Agent 行为观察（供 C 级审核参考）\n${observationContext}`;

        // M1 截断降级：若第一条观察记录的 taskId 存在，检查截断状态
        const sampleTaskId = observations[0]?.taskId;
        if (sampleTaskId && observationRecorder.isTruncated(turn.sessionId, sampleTaskId)) {
          systemPrompt += `\n\n⚠️ **观察队列被截断**（部分历史记录因窗口限制被裁剪）。你看到的行为记录可能不完整，审核结论请保守判定，对不确定的问题标注 "低置信度"。`;
        }
      }
    }

    // Inject validated system insights for review decisions
    const reviewInsights = recallInsightsForDecision(db, 'review', 3);
    if (reviewInsights.length > 0) {
      systemPrompt += formatInsightsBlock(reviewInsights);
      markInsightAdoptedByDecision(db, 'review', reviewInsights.map(i => i.id));
    }

    // §5.2 ④: Recall historical review decisions for learning
    systemPrompt += recallDecisionsBlock('review');

    const reviewContent = buildReviewInput(turn.level, turn);
    const messages: ModelMessage[] = [
      { role: 'user', content: reviewContent },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: turn.level === 'A' ? 1024 : 2048,
        temperature: 0.3,
        agent: name,
        purpose: 'brain_review',
        sessionId: turn.sessionId,
        correlationId: trackingId,
      });

      let reviewResult: ReviewResult;
      try {
        const parsed = JSON.parse(result.content);
        reviewResult = {
          verdict: parsed.verdict ?? 'approve',
          finalResponse: parsed.finalResponse,
          reason: parsed.reason,
          reRoute: parsed.reRoute || undefined,
        };
      } catch {
        reviewResult = { verdict: 'approve', reason: 'Failed to parse review, approving by default' };
      }

      logger.debug({ level: turn.level, verdict: reviewResult.verdict, reason: safeSlice(reviewResult.reason, 200), hasReRoute: !!reviewResult.reRoute, draftLen: turn.draftResponse?.length }, 'brain:review');

      // 13.0 P10: 派发独立 checker 审核（仅当 squad 里有 check 角色成员时）
      // 不阻塞主 review.result — checker 的 verdict 通过 brain.signal_intervention 事件异步影响后续 plan
      if (turn.planTaskId && turn.missionId) {
        dispatchCheckerReview(turn.missionId, turn.planTaskId, turn, reviewResult, trackingId);
      }

      ipc.send('review.result', 'core', reviewResult, trackingId);

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

      const fallbackInput: FallbackReviewInput = {
        responseText: turn.draftResponse,
        hasToolCalls: turn.toolCalls.length > 0,
        toolNames: turn.toolCalls.map(tc => tc.name),
        agentName: name,
      };
      const fallbackResult = fallbackReviewer.review(fallbackInput);

      // 映射 FallbackReviewer 三态到 ReviewResult
      let verdict: ReviewResult['verdict'];
      let reason: string;
      switch (fallbackResult.verdict) {
        case 'deny':
          // 检测到危险内容 → 拒绝（安全优先）
          verdict = 'reject';
          reason = `Brain LLM 不可用，规则审核拒绝: ${fallbackResult.reason}`;
          break;
        case 'hold':
          // 风险不确定 → 修改回复添加警告标记
          verdict = 'modify';
          reason = `Brain LLM 不可用，规则审核标记需人工确认: ${fallbackResult.reason}`;
          break;
        case 'approve':
        default:
          // 规则审核通过（简单文本、无风险模式）
          verdict = 'approve';
          reason = `Brain LLM 不可用，规则审核批准: ${fallbackResult.reason}`;
          break;
      }

      ipc.send('review.result', 'core', {
        verdict,
        reason,
      } satisfies ReviewResult, trackingId);
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
  const PROMPT_SELF_MOD_LESSON_THRESHOLD = 3; // 同一 promptKey 累积 3 条 lesson 后触发自修改

  ipc.onMessage('brain.review.feedback', (msg: IpcMessage) => {
    const payload = msg.payload as { decisionId?: string; feedbackType?: string; lesson?: string; outcome?: 'good' | 'bad' | 'neutral'; promptKey?: string };
    if (!payload?.decisionId || !payload.lesson) {
      ipc.send('brain.review.feedback.result', 'core', { ok: false, reason: 'Missing decisionId or lesson' }, msg.correlationId ?? msg.id);
      return;
    }
    try {
      decisionRecorder.updateLesson(payload.decisionId, payload.lesson);
      // 同时记录一条新的 decision（outcome 字段记录用户反馈）
      if (payload.outcome) {
        decisionRecorder.record({
          sessionId: 'feedback:' + payload.decisionId,
          decisionType: 'review',
          inputSummary: `feedback_type=${payload.feedbackType ?? 'unknown'}`,
          outputJson: { decisionId: payload.decisionId, feedbackType: payload.feedbackType },
          outcome: payload.outcome,
        });
      }
      logger.info({
        decisionId: payload.decisionId,
        feedbackType: payload.feedbackType,
        lessonLen: payload.lesson.length,
      }, 'brain:self-review feedback recorded');

      // ── §3.1 提示能力: 检查是否触发 prompt 自修改 ──
      // 根据反馈类型推断应该修改哪个 prompt key
      const promptKey = payload.promptKey ?? inferPromptKeyFromFeedback(payload.feedbackType);
      if (promptKey) {
        tryTriggerPromptSelfMod(promptKey, payload.lesson);
      }

      ipc.send('brain.review.feedback.result', 'core', { ok: true, id: payload.decisionId }, msg.correlationId ?? msg.id);
    } catch (err) {
      logger.warn({ err, decisionId: payload.decisionId }, 'brain:self-review feedback failed');
      ipc.send('brain.review.feedback.result', 'core', { ok: false, reason: (err as Error).message }, msg.correlationId ?? msg.id);
    }
  });

  /**
   * §3.1 提示能力: 根据反馈类型推断应该修改哪个 prompt key。
   * 映射关系：
   *   - 路由反馈 → brain.routing
   *   - 审核反馈 → brain.review.a 或 brain.review.bc
   *   - 权限反馈 → brain.permission
   *   - 默认 → null（不触发自修改）
   */
  function inferPromptKeyFromFeedback(feedbackType?: string): string | null {
    if (!feedbackType) return null;
    if (feedbackType.includes('route') || feedbackType.includes('routing')) return 'brain.routing';
    if (feedbackType.includes('review_a') || feedbackType.includes('review_a')) return 'brain.review.a';
    if (feedbackType.includes('review') || feedbackType.includes('modify') || feedbackType.includes('reject')) return 'brain.review.bc';
    if (feedbackType.includes('permission') || feedbackType.includes('tool')) return 'brain.permission';
    return null;
  }

  /**
   * §3.1 提示能力: 检查该 promptKey 下的 lessons 是否达到阈值，触发 prompt 自修改。
   *
   * 机制：
   *   1. 从 brain_decisions 查询该 promptKey 相关的、带 lesson 的决策
   *   2. 如果未处理的 lessons 数量 >= PROMPT_SELF_MOD_LESSON_THRESHOLD (3)
   *   3. 把这些 lessons 合并为一条 "prompt 增补指令"，追加到当前 prompt 末尾
   *   4. 调用 PromptVersioning.propose() 创建新版本
   *   5. 下次 Brain 使用该 prompt 时自动读取新版本（getReviewPrompt 等）
   *
   * 安全边界：
   *   - 新版本的内容 = 当前 active prompt + lessons 合并的增补段
   *   - 不删除原有内容，只追加 "## 自动学习的教训" 段落
   *   - 可通过 PromptVersioning.rollback() 回滚
   */
  function tryTriggerPromptSelfMod(promptKey: string, newLesson: string): void {
    try {
      // 查询该 promptKey 相关的、带 lesson 的决策
      const lessonsWithFeedback = db.prepare(`
        SELECT lesson FROM brain_decisions
        WHERE decision_type = 'review'
          AND lesson IS NOT NULL AND lesson != ''
          AND input_summary LIKE '%' || ? || '%'
        ORDER BY created_at DESC LIMIT ?
      `).all(promptKey, PROMPT_SELF_MOD_LESSON_THRESHOLD + 2) as Array<{ lesson: string }>;

      // 如果带 lesson 的决策不够，尝试更宽泛的查询
      const allLessons = lessonsWithFeedback.length >= PROMPT_SELF_MOD_LESSON_THRESHOLD
        ? lessonsWithFeedback
        : (db.prepare(`
            SELECT lesson FROM brain_decisions
            WHERE lesson IS NOT NULL AND lesson != ''
            ORDER BY created_at DESC LIMIT ?
          `).all(PROMPT_SELF_MOD_LESSON_THRESHOLD) as Array<{ lesson: string }>);

      if (allLessons.length < PROMPT_SELF_MOD_LESSON_THRESHOLD) {
        logger.debug({
          promptKey,
          lessonCount: allLessons.length,
          threshold: PROMPT_SELF_MOD_LESSON_THRESHOLD,
        }, 'brain:prompt-self-mod not triggered (lessons below threshold)');
        return;
      }

      // 获取当前 active prompt
      const current = promptVersioning.getActiveVersion(promptKey);
      const baseContent = current?.content ?? getDefaultPromptContent(promptKey);

      // 构建增补段：合并 lessons 为简洁的指导原则
      const lessonLines = allLessons
        .slice(0, PROMPT_SELF_MOD_LESSON_THRESHOLD)
        .map((l, i) => `${i + 1}. ${l.lesson.slice(0, 200)}`);

      const supplement = `\n\n## 自动学习的教训（基于 ${allLessons.length} 条反馈，${new Date().toISOString().slice(0, 10)} 更新）\n${lessonLines.join('\n')}`;

      // 检查是否已包含同样的增补内容（防止重复追加）
      if (baseContent.includes(supplement.slice(0, 50))) {
        logger.debug({ promptKey }, 'brain:prompt-self-mod skipped (supplement already present)');
        return;
      }

      // 追加到当前 prompt 末尾
      const newContent = baseContent + supplement;

      // 创建新版本
      const version = promptVersioning.propose({
        promptKey,
        newContent,
        changeReason: `自动学习：基于 ${allLessons.length} 条审核反馈教训`,
        changeSource: 'brain',
        currentMetrics: { lessonCount: allLessons.length },
      });

      logger.info({
        promptKey,
        version: version.version,
        lessonCount: allLessons.length,
      }, 'brain:prompt-self-mod triggered — new prompt version created');
    } catch (err) {
      // prompt 自修改失败不应阻塞反馈流程
      logger.warn({ err, promptKey }, 'brain:prompt-self-mod failed (non-critical)');
    }
  }

  /** 获取 promptKey 的默认内容（当没有 active version 时） */
  function getDefaultPromptContent(promptKey: string): string {
    switch (promptKey) {
      case 'brain.review.a': return DEFAULT_PROMPT_A;
      case 'brain.review.bc': return DEFAULT_PROMPT_BC;
      case 'brain.routing': return buildRoutingSystemPrompt();
      case 'brain.permission': return buildPermissionJudgeSystemPrompt();
      default: return '';
    }
  }

  /**
   * 13.0 P10: 派发独立 checker 审核。
   *
   * 工作流：
   *   1. 通过 MissionManager.getCheckerForPlanTask 找到 squad 内 check 角色成员
   *   2. 如果存在，给 checker agent 发 IPC 消息请它独立审查 worker 的产出
   *   3. checker 的审查结果通过 brain.signal_intervention 事件回传（processCheckResult 中处理）
   *
   * 注意：checker 的 verdict 不会阻塞 review.result；它作为异步信号影响 plan 后续迭代。
   * 这避免了「checker 卡住 → 主任务挂起」的级联失败。
   *
   * @param missionId Mission ID
   * @param planTaskId 当前 worker 完成的 plan 任务
   * @param turn 完整 turn 记录（checker 需要的上下文）
   * @param brainReviewResult 主 Brain 的审核结果（checker 用于对比）
   * @param parentCorrelationId 父 review 的 correlationId
   */
  function dispatchCheckerReview(
    missionId: string,
    planTaskId: string,
    turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: Array<{ name: string; input: string; result: string }>; taskDescription?: string },
    brainReviewResult: ReviewResult,
    parentCorrelationId: string,
  ): void {
    try {
      const checker = missionManager.getCheckerForPlanTask(missionId, planTaskId);
      if (!checker) return; // 没有 checker 就不派发

      // 13.0 §11.4: 通过 EventBus 发 brain.checker.dispatch 事件
      // Kernel 订阅后调 ensureAgent(checker.agent) 启动它，然后转交 review.request 给 checker
      // 这里不阻塞主 review.result（避免 checker 卡住导致 worker 主任务挂起）
      const checkerCorrelationId = genId('check');
      getEventBus().emit('brain.checker.dispatch', {
        missionId,
        planTaskId,
        sessionId: turn.sessionId,
        checkerAgent: checker.agent,
        checkerOn: checker.on,
        checkerCorrelationId,
        parentCorrelationId,
        workerOutput: turn.draftResponse,
        workerTask: turn.taskDescription ?? planTaskId,
        brainVerdict: brainReviewResult.verdict,
        brainReason: brainReviewResult.reason ?? '',
      });

      // 记录决策（审计 + 后续 evolution 学习）
      decisionRecorder.record({
        sessionId: turn.sessionId,
        decisionType: 'review',
        inputSummary: `dispatched checker review for planTaskId=${planTaskId}`,
        outputJson: {
          action: 'dispatch_checker',
          checkerAgent: checker.agent,
          parentCorrelationId,
          checkerCorrelationId,
          brainVerdict: brainReviewResult.verdict,
          missionId,
          planTaskId,
        },
      });

      logger.info({
        missionId,
        planTaskId,
        checkerAgent: checker.agent,
        checkerCorrelationId,
        brainVerdict: brainReviewResult.verdict,
      }, 'brain:p10 checker review dispatched');
    } catch (err) {
      logger.warn({ err, missionId, planTaskId }, 'brain:p10 dispatchCheckerReview failed');
    }
  }

  // --- Handler 2: route.request (NEW — intent analysis + routing) ---

  ipc.onMessage('route.request', async (msg: IpcMessage) => {
    const payload = msg.payload as RouteRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;

    let systemPrompt = getRoutingPrompt();

    // Inject validated system insights for routing decisions
    const insights = recallInsightsForDecision(db, 'route', 5);
    if (insights.length > 0) {
      systemPrompt += formatInsightsBlock(insights);
      markInsightAdoptedByDecision(db, 'route', insights.map(i => i.id));
    }

    // Recall historical routing decisions for dynamic context (§3.3)
    systemPrompt += recallDecisionsBlock('route');

    const userPrompt = buildRoutingUserPrompt(
      payload.message,
      payload.availableAgents,
      payload.sessionContext,
    );

    const messages: ModelMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: 1024,
        temperature: 0.1,
        agent: name,
        purpose: 'brain_routing',
        sessionId: payload.sessionId,
        correlationId: trackingId,
      });

      const decision = parseRouteDecision(result.content);
      logger.debug({ intent: decision.intent, target: decision.targetAgent, reason: safeSlice(decision.reason, 200), agents: payload.availableAgents.map((a: { name: string }) => a.name) }, 'brain:route');
      const routeResult: RouteResultPayload = { decision };
      ipc.send('route.result', 'core', routeResult, trackingId);

      // Mark recalled insights as adopted on successful routing
      if (insights.length > 0) {
        markInsightAdoptedByDecision(db, 'route', insights.map(i => i.id));
      }
    } catch (err) {
      const fallback: RouteResultPayload = {
        decision: {
          intent: 'chat',
          targetAgent: 'conversation',
          priority: 'normal',
          reason: `路由 LLM 失败: ${(err as Error).message}，fallback 到对话`,
        },
      };
      ipc.send('route.result', 'core', fallback, trackingId);
    }
  });

  // --- Handler 3: permission.judge (NEW — LLM-based permission approval) ---

  ipc.onMessage('permission.judge', async (msg: IpcMessage) => {
    const payload = msg.payload as PermissionJudgeRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;

    let systemPrompt = getPermissionPrompt();

    // Inject validated system insights for permission decisions
    const permInsights = recallInsightsForDecision(db, 'permission', 3);
    if (permInsights.length > 0) {
      systemPrompt += formatInsightsBlock(permInsights);
      markInsightAdoptedByDecision(db, 'permission', permInsights.map(i => i.id));
    }
    systemPrompt += recallDecisionsBlock('permission');

    const userPrompt = buildPermissionJudgeUserPrompt(
      payload.toolName,
      payload.toolInput,
      payload.dangerLevel,
      payload.taskContext,
    );

    const messages: ModelMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: 1024,
        temperature: 0.0,
        agent: name,
        purpose: 'brain_permission',
        sessionId: payload.sessionId,
        correlationId: trackingId,
      });

      const judgment = parsePermissionJudge(result.content);
      logger.debug({ tool: payload.toolName, allowed: judgment.allowed, reason: safeSlice(judgment.reason, 200), dangerLevel: payload.dangerLevel }, 'brain:permission');
      const judgeResult: PermissionJudgeResultPayload = judgment;
      ipc.send('permission.judge.result', 'core', judgeResult, trackingId);
    } catch (err) {
      ipc.send('permission.judge.result', 'core', {
        allowed: false,
        reason: `权限判断 LLM 失败: ${(err as Error).message}`,
      } satisfies PermissionJudgeResultPayload, trackingId);
    }
  });

  // --- Handler 4: agent.ask_user (NEW — review agent's question to user) ---

  ipc.onMessage('agent.ask_user', async (msg: IpcMessage) => {
    const payload = msg.payload as AgentAskUserPayload;
    const trackingId = msg.correlationId ?? msg.id;

    const systemPrompt = buildAskUserReviewSystemPrompt();
    const userPrompt = `## 智能体追问\n\n- 任务ID: ${payload.taskId}\n- 问题: ${payload.question}\n${payload.options ? `- 选项: ${payload.options.join(', ')}\n` : ''}${payload.context ? `- 上下文: ${payload.context}` : ''}`;

    const messages: ModelMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: 1024,
        temperature: 0.1,
        agent: name,
        purpose: 'brain_ask_review',
        sessionId: payload.sessionId,
        correlationId: trackingId,
      });

      const review = parseAskUserReview(result.content);
      ipc.send('agent.ask_user', 'core', {
        ...payload,
        _brainReview: review,
      }, trackingId);
    } catch {
      ipc.send('agent.ask_user', 'core', {
        ...payload,
        _brainReview: { approved: true },
      }, trackingId);
    }
  });

  // --- Handler 5: checkpoint.evaluate (Layer 3 semantic correction) ---

  ipc.onMessage('checkpoint.evaluate', async (msg: IpcMessage) => {
    const payload = msg.payload as TurnCheckpointPayload;
    const trackingId = msg.correlationId ?? msg.id;

    const systemPrompt = buildCheckpointSystemPrompt();
    const userPrompt = buildCheckpointUserPrompt(payload);

    const messages: ModelMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: CORRECTION_LIMITS.maxCorrectionTokens,
        temperature: 0.1,
        agent: name,
        purpose: 'brain_checkpoint',
        sessionId: 'system',
        correlationId: trackingId,
      });

      const correction = parseCheckpointResult(result.content, payload.delegationId);
      ipc.send('checkpoint.evaluate.result', 'core', correction, trackingId);
    } catch (err) {
      ipc.send('checkpoint.evaluate.result', 'core', {
        delegationId: payload.delegationId,
        action: 'continue',
      } satisfies TurnCorrectionPayload, trackingId);
    }
  });

  // --- Handler 6: superior.review.request (上级审核) ---

  ipc.onMessage('superior.review.request', async (msg: IpcMessage) => {
    const request = msg.payload as SuperiorReviewRequest;
    const trackingId = msg.correlationId ?? msg.id;

    const systemPrompt = buildSuperiorReviewSystemPrompt();
    const userPrompt = buildSuperiorReviewUserPrompt(request);

    const messages: ModelMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    try {
      const result = await llm.current.chat(messages, {
        system: systemPrompt,
        maxTokens: 1024,
        temperature: 0.1,
        agent: name,
        purpose: 'superior_review',
        sessionId: 'system',
        correlationId: trackingId,
      });

      const reviewResult = parseSuperiorReviewResult(
        result.content, request.delegationId, request.superiorId, request.correlationId,
      );
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
  const dialogueBuffers = new Map<string, { messages: Array<{ from: string; content: string; round: number }>; lastActivity: number }>();

  ipc.onMessage('dialogue.observe', async (msg: IpcMessage) => {
    const payload = msg.payload as import('../../../contracts/dialogue.js').DialogueObservePayload;
    const { message, currentRound, sessionId } = payload;
    const dialogueId = message.dialogueId;

    // 累积对话消息（保留最近 10 条）
    if (!dialogueBuffers.has(dialogueId)) {
      dialogueBuffers.set(dialogueId, { messages: [], lastActivity: Date.now() });
    }
    const buffer = dialogueBuffers.get(dialogueId)!;
    buffer.messages.push({ from: message.from, content: safeSlice(message.content, 500), round: currentRound });
    if (buffer.messages.length > 10) buffer.messages.shift();
    buffer.lastActivity = Date.now();

    // 规则式干预判断（不调 LLM，保持低成本）
    let intervention: { instruction: string; reason: string } | null = null;

    // 规则 1：对话轮次过多且无进展
    // L3: 可配置化，从 agent.json manifest 经 env var 传入
    const maxObserveRounds = parseInt(process.env.AGENT_OBSERVE_MAX_ROUNDS ?? '8', 10);
    if (currentRound >= maxObserveRounds) {
      const recentContents = buffer.messages.slice(-4).map(m => m.content);
      const hasRepetition = recentContents.some((c, i) =>
        i > 0 && recentContents[i - 1].slice(0, 100) === c.slice(0, 100),
      );
      if (hasRepetition) {
        intervention = {
          instruction: '对话陷入循环。请总结已有信息，做出决策或直接回复用户。不要继续追问。',
          reason: 'dialogue_loop_detected',
        };
      }
    }

    // 规则 2：连续 3 次 needsClarification
    if (!intervention && buffer.messages.length >= 6) {
      const lastThreeReplies = buffer.messages.filter(m => m.from !== 'conversation').slice(-3);
      // 无法直接看到 metadata，但可以检查内容中是否有"不确定"/"需要确认"等模式
      const uncertainCount = lastThreeReplies.filter(m =>
        m.content.includes('需要确认') || m.content.includes('不确定') || m.content.includes('请提供更多'),
      ).length;
      if (uncertainCount >= 3) {
        intervention = {
          instruction: '目标智能体连续表示不确定。考虑直接询问用户获取必要信息，或基于现有信息做出最佳判断。',
          reason: 'repeated_uncertainty',
        };
      }
    }

    // 发送纠偏（直接通过 IPC 发 turn.correction 给 Conversation，action='adjust' + instruction）
    if (intervention) {
      logger.info({ dialogueId, reason: intervention.reason, round: currentRound }, 'brain:dialogue intervention');
      ipc.send('turn.correction', 'core', {
        delegationId: dialogueId,
        action: 'adjust' as const,
        instruction: intervention.instruction,
      } satisfies TurnCorrectionPayload, msg.correlationId ?? msg.id);
    }

    // 12.0: 每 3 轮做语义对齐检测（仅当有 intentAnchor 且无规则式干预时）
    if (!intervention && currentRound > 0 && currentRound % 3 === 0 && payload.intentAnchor) {
      try {
        const { buildDriftCheckPrompt, parseDriftCheckResult } = await import('../../../kernel/drift-detector.js');
        const recentContent = buffer.messages.slice(-3).map(m => `[${m.from}]: ${m.content}`).join('\n');
        const prompt = buildDriftCheckPrompt(payload.intentAnchor, recentContent, 'dialogue');

        const result = await llm.current.chat(
          [{ role: 'user', content: prompt }],
          { system: '你是语义对齐检测器。只输出 JSON。', maxTokens: 200, temperature: 0, agent: name, purpose: 'drift_detection' },
        );

        const signal = parseDriftCheckResult(result.content, 'dialogue');
        if (signal.needsIntervention && signal.alignmentScore < 0.5) {
          logger.info({ dialogueId, score: signal.alignmentScore, desc: safeSlice(signal.driftDescription, 100) }, 'brain:dialogue semantic drift');
          ipc.send('turn.correction', 'core', {
            delegationId: dialogueId,
            action: 'adjust' as const,
            instruction: `对话可能偏离了用户原始意图。用户的目标是："${payload.intentAnchor.goal}"。${signal.driftDescription ? `当前问题：${signal.driftDescription}。` : ''}请重新对齐用户意图后继续。`,
          } satisfies TurnCorrectionPayload, msg.correlationId ?? msg.id);
        }
      } catch (err) {
        logger.debug({ err, dialogueId }, 'dialogue semantic drift check failed, skipping');
      }
    }

    // 定期清理过期 buffer（5 分钟无活动）
    for (const [id, buf] of dialogueBuffers) {
      if (Date.now() - buf.lastActivity > 5 * 60_000) {
        dialogueBuffers.delete(id);
      }
    }
  });

  // ─── 12.0: drift.check.request — 漂移检测 LLM 调用 ───
  ipc.onMessage('drift.check.request', async (msg: IpcMessage) => {
    const { anchor, content, checkpointType } = msg.payload as import('../../../kernel/drift-detector.js').DriftCheckRequestPayload;
    const trackingId = msg.correlationId ?? msg.id;

    try {
      const { buildDriftCheckPrompt, parseDriftCheckResult } = await import('../../../kernel/drift-detector.js');
      const prompt = buildDriftCheckPrompt(anchor, content, checkpointType);

      const result = await llm.current.chat(
        [{ role: 'user', content: prompt }],
        {
          system: '你是语义对齐检测器。只输出 JSON，不要有任何其他文本。',
          maxTokens: 200,
          temperature: 0,
          agent: name,
          purpose: 'drift_detection',
          sessionId: undefined,
          correlationId: trackingId,
        },
      );

      const signal = parseDriftCheckResult(result.content, checkpointType);
      logger.debug({ checkpointType, alignmentScore: signal.alignmentScore, needsIntervention: signal.needsIntervention }, 'brain:drift-check');
      ipc.send('drift.check.result', 'core', { signal }, trackingId);
    } catch (err) {
      logger.error({ err, checkpointType }, 'drift.check.request failed');
      // 失败时返回"不干预"默认值
      const fallbackSignal = { alignmentScore: 1, needsIntervention: false, checkpointType };
      ipc.send('drift.check.result', 'core', { signal: fallbackSignal }, trackingId);
    }
  });

  // ─── 12.0: verify.request — 独立意图验证（Verify Gate） ───
  ipc.onMessage('verify.request', async (msg: IpcMessage) => {
    const { anchor, draftResponse } = msg.payload as { anchor: import('../../../contracts/intent.js').IntentAnchor; draftResponse: string };
    const trackingId = msg.correlationId ?? msg.id;

    try {
      const verifyPrompt = `你是一个独立的意图验证器。你的任务是判断最终回复是否真正解决了用户的问题。

## 用户原始意图
目标：${anchor.goal}
约束：${anchor.constraints.length > 0 ? anchor.constraints.join('；') : '无'}
预期产出类型：${anchor.outputType}

## 待验证的回复
${safeSlice(draftResponse, 5000)}

## 验证标准
1. 回复是否直接回答了用户的问题/完成了用户的请求？
2. 是否违反了用户的约束条件？
3. 是否有"答非所问"的情况（看似在回答但偏了方向）？

只输出 JSON：{"pass": true/false, "reason": "<一句话判决理由>", "correction": "<修正指导或null>"}`;

      const result = await llm.current.chat(
        [{ role: 'user', content: verifyPrompt }],
        {
          system: '你是独立意图验证器，以对抗性视角审视回复是否真正解决了用户问题。只输出 JSON。',
          maxTokens: 300,
          temperature: 0,
          agent: name,
          purpose: 'brain_review',
          modelTier: 'default',
          sessionId: undefined,
          correlationId: trackingId,
        },
      );

      // 解析验证结果
      let verdict = { pass: true, reason: '验证通过', correction: undefined as string | undefined };
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          verdict = {
            pass: Boolean(parsed.pass),
            reason: typeof parsed.reason === 'string' ? parsed.reason : '未知',
            correction: typeof parsed.correction === 'string' ? parsed.correction : undefined,
          };
        }
      } catch { /* 解析失败默认通过 */ }

      logger.debug({ pass: verdict.pass, reason: safeSlice(verdict.reason ?? '', 100) }, 'brain:verify');
      ipc.send('verify.result', 'core', { verdict }, trackingId);
    } catch (err) {
      logger.error({ err }, 'verify.request failed');
      ipc.send('verify.result', 'core', { verdict: { pass: true, reason: '验证服务异常，默认通过' } }, trackingId);
    }
  });

  // ─── 13.0 §13.8: cron 任务审核（LLM + 规则双路径） ───
  // cron.review 事件由 CronScheduler 在任务执行成功后发出，
  // Brain 订阅后使用 cron.description 作为"用户意图"进行审核判定。
  // 策略：输出短/简单 → 规则化快速通过；输出长/复杂 → LLM 审核
  // 由于 Brain 是 resident agent，通过 EventBus 订阅（非 IPC）。
  const eventBus = getEventBus();
  eventBus.on('cron.review', async (payload) => {
    const { taskId, description, output } = payload as { taskId: string; description: string; output: string; createdAt: number };
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

    // ── 复杂/长输出：调用 LLM 审核 ──
    try {
      const cronSystemPrompt = buildCronReviewSystemPrompt();
      const cronUserPrompt = buildCronReviewUserPrompt(description ?? '', output);
      const messages: ModelMessage[] = [
        { role: 'user', content: cronUserPrompt },
      ];

      const result = await llm.current.chat(messages, {
        system: cronSystemPrompt,
        maxTokens: 1024,
        temperature: 0.2,
        agent: name,
        purpose: 'brain_cron_review',
        sessionId: `cron:${taskId}`,
      });

      const cronResult = parseCronReviewResult(result.content);
      logger.info({
        taskId,
        verdict: cronResult.verdict,
        confidence: cronResult.confidence,
        reason: safeSlice(cronResult.reason, 200),
      }, 'brain:cron.review LLM verdict');

      decisionRecorder.record({
        sessionId: `cron:${taskId}`,
        decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: {
          output: safeSlice(output, 2000),
          autoApproved: cronResult.verdict === 'approve',
          llmVerdict: cronResult.verdict,
          llmReason: safeSlice(cronResult.reason, 500),
          correctedOutput: cronResult.correctedOutput ? safeSlice(cronResult.correctedOutput, 1000) : undefined,
          path: 'llm',
        },
        confidence: cronResult.confidence,
        taskId,
      });

      // 如果审核发现问题，通过 EventBus 广播（前端可展示警告）
      if (cronResult.verdict !== 'approve') {
        eventBus.emit('brain.cron_review_flagged', {
          taskId,
          verdict: cronResult.verdict,
          reason: cronResult.reason,
          correctedOutput: cronResult.correctedOutput,
        });
      }
    } catch (err) {
      // LLM 失败时降级为规则化通过（不阻塞 cron 流程）
      logger.warn({ err: (err as Error).message, taskId }, 'brain:cron.review LLM failed, falling back to rule-based');
      decisionRecorder.record({
        sessionId: `cron:${taskId}`,
        decisionType: 'cron_review',
        inputSummary: safeSlice(description, 500),
        outputJson: { output: safeSlice(output, 2000), autoApproved: true, path: 'fallback' },
        confidence: 0.5,
        taskId,
      });
    }
  });
});
