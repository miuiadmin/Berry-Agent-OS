import { startResidentAgent } from '../../resident-agent.js';
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
  "reRoute": null
}

Rules:
- "approve": response is appropriate, tool usage is safe, no harmful patterns
- "modify": issues found but fixable — provide the corrected version
- "reject": harmful actions, data leaks, or dangerous tool misuse — provide a safe alternative
- If rejecting because the wrong agent handled it, set "reRoute" to a RouteDecision object

Pay special attention to:
- Whether tool calls were necessary and appropriate
- Whether sensitive data is being exposed in the response
- Whether the response accurately reflects tool results`;

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
  // Initialize prompt versioning for self-modification support
  const promptVersioning = new PromptVersioning(db);
  const decisionRecorder = new BrainDecisionRecorder(db);

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
      const result = await llm.chat(messages, {
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
      const result = await llm.chat(messages, {
        system: systemPrompt,
        maxTokens: 512,
        temperature: 0.1,
        agent: name,
        purpose: 'brain_routing',
        sessionId: payload.sessionId,
        correlationId: trackingId,
      });

      const decision = parseRouteDecision(result.content);
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
      const result = await llm.chat(messages, {
        system: systemPrompt,
        maxTokens: 256,
        temperature: 0.0,
        agent: name,
        purpose: 'brain_permission',
        sessionId: payload.sessionId,
        correlationId: trackingId,
      });

      const judgment = parsePermissionJudge(result.content);
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
      const result = await llm.chat(messages, {
        system: systemPrompt,
        maxTokens: 512,
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
      const result = await llm.chat(messages, {
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
      const result = await llm.chat(messages, {
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
});
