import { startResidentAgent } from '../../resident-agent.js';
import { getLogger } from '../../../utils/logger.js';
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
} from './prompts.js';
import type { IpcMessage } from '../../../kernel/types.js';
import type { RouteRequestPayload, PermissionJudgeRequestPayload } from '../../../contracts/routing.js';
import type { SuperiorReviewRequest } from '../../../contracts/superior-review.js';
import { recallInsightsForDecision, formatInsightsBlock } from '../../../kernel/insights-recall.js';
import { markInsightAdoptedByDecision } from '../../../kernel/insights-lifecycle.js';
import { BrainDecisionRecorder } from '../../../kernel/brain-decision-recorder.js';
import { ObservationRecorder, type RecordObservationInput, type ObservationType } from '../../../kernel/observation-recorder.js';
import { PromptVersioning } from '../../../kernel/prompt-versioning.js';

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

Pay special attention to:
- Whether tool calls were necessary and appropriate
- Whether sensitive data is being exposed in the response
- Whether the response accurately reflects tool results
- **Intent alignment**: Does the response directly answer the user's question? If it drifts from the user's intent (even if content is technically correct), mark intentAlignment as "partial" or "misaligned"`;

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
        content: payload.content.slice(0, 2000),
        priority: payload.priority ?? 1,
        metadata: payload.metadata,
      };
      observationRecorder.record(recordInput);
    } catch (err) {
      // 观察记录失败不应阻塞其他业务
      logger.warn({ err, sessionId: payload.sessionId, taskId: payload.taskId }, 'brain.observe:record failed');
    }
  });

  function recallDecisionsBlock(decisionType: string): string {
    const decisions = decisionRecorder.recallForDecision(decisionType, 5);
    if (decisions.length === 0) return '';
    const lines = decisions.map(d => {
      const outcome = d.outcome ? ` [${d.outcome}]` : '';
      const lesson = d.lesson ? ` 教训: ${d.lesson}` : '';
      return `- ${d.inputSummary.slice(0, 80)}${outcome}${lesson}`;
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

  // --- Handler 1: review.request (existing, enhanced with reRoute) ---

  ipc.onMessage('review.request', async (msg: IpcMessage) => {
    const { turn } = msg.payload as { turn: { sessionId: string; userMessage: string; draftResponse: string; toolCalls: Array<{ name: string; input: string; result: string }>; level: 'A' | 'B' | 'C' } };
    const trackingId = msg.correlationId ?? msg.id;

    const reviewContent = buildReviewInput(turn.level, turn);
    let systemPrompt = getReviewPrompt(turn.level);

    // Inject World Model context for review decisions
    const worldSummary = getWorldModelSummary(db);
    if (worldSummary) {
      systemPrompt += `\n\n[World State] ${worldSummary}`;
    }

    // Inject validated system insights for review decisions
    const reviewInsights = recallInsightsForDecision(db, 'review', 3);
    if (reviewInsights.length > 0) {
      systemPrompt += formatInsightsBlock(reviewInsights);
      markInsightAdoptedByDecision(db, 'review', reviewInsights.map(i => i.id));
    }

    // §5.2 ④: Recall historical review decisions for learning
    systemPrompt += recallDecisionsBlock('review');

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

      logger.debug({ level: turn.level, verdict: reviewResult.verdict, reason: reviewResult.reason?.slice(0, 200), hasReRoute: !!reviewResult.reRoute, draftLen: turn.draftResponse?.length }, 'brain:review');
      ipc.send('review.result', 'core', reviewResult, trackingId);
    } catch (err) {
      ipc.send('review.result', 'core', {
        verdict: 'approve',
        reason: `Review error: ${(err as Error).message}, approving by default`,
      } satisfies ReviewResult, trackingId);
    }
  });

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
      logger.debug({ intent: decision.intent, target: decision.targetAgent, reason: decision.reason?.slice(0, 200), agents: payload.availableAgents.map((a: { name: string }) => a.name) }, 'brain:route');
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
      logger.debug({ tool: payload.toolName, allowed: judgment.allowed, reason: judgment.reason?.slice(0, 200), dangerLevel: payload.dangerLevel }, 'brain:permission');
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
    buffer.messages.push({ from: message.from, content: message.content.slice(0, 500), round: currentRound });
    if (buffer.messages.length > 10) buffer.messages.shift();
    buffer.lastActivity = Date.now();

    // 规则式干预判断（不调 LLM，保持低成本）
    let intervention: { instruction: string; reason: string } | null = null;

    // 规则 1：对话轮次过多且无进展
    if (currentRound >= 8) {
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
          logger.info({ dialogueId, score: signal.alignmentScore, desc: signal.driftDescription?.slice(0, 100) }, 'brain:dialogue semantic drift');
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
${draftResponse.slice(0, 5000)}

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

      logger.debug({ pass: verdict.pass, reason: verdict.reason?.slice(0, 100) }, 'brain:verify');
      ipc.send('verify.result', 'core', { verdict }, trackingId);
    } catch (err) {
      logger.error({ err }, 'verify.request failed');
      ipc.send('verify.result', 'core', { verdict: { pass: true, reason: '验证服务异常，默认通过' } }, trackingId);
    }
  });
});
