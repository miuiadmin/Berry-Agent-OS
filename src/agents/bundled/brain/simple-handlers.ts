/**
 * 简单 brain handler 核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * agent.ask_user + superior.review.request——两个最简单的 LLM-call→parse→return handler。
 * 共享状态最小（仅 llm/name），提取为纯函数，entry.ts 保留 ipc.onMessage/send 薄包装。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { AgentAskUserPayload } from '../../../contracts/routing.js';
import type { SuperiorReviewRequest } from '../../../contracts/superior-review.js';
import {
  buildAskUserReviewSystemPrompt,
  parseAskUserReview,
} from './prompts.js';
import {
  buildSuperiorReviewSystemPrompt,
  buildSuperiorReviewUserPrompt,
  parseSuperiorReviewResult,
} from './prompts.js';

type ChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/**
 * agent.ask_user 核心逻辑（brain 审查 agent 向用户的追问——approve/reject/modify）。
 */
export async function evaluateAskUser(
  payload: AgentAskUserPayload,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
  const systemPrompt = buildAskUserReviewSystemPrompt();
  const userPrompt = `## 智能体追问\n\n- 任务ID: ${payload.taskId}\n- 问题: ${payload.question}\n${payload.options ? `- 选项: ${payload.options.join(', ')}\n` : ''}${payload.context ? `- 上下文: ${payload.context}` : ''}`;
  const result = await chat([{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: 1024,
    temperature: 0.1,
    agent: name,
    purpose: 'brain_ask_review',
    sessionId: payload.sessionId,
    correlationId: trackingId,
  });
  return parseAskUserReview(result.content);
}

/**
 * superior.review.request 核心逻辑（上级 agent 审核下级产出）。
 */
export async function evaluateSuperiorReview(
  request: SuperiorReviewRequest,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
  const systemPrompt = buildSuperiorReviewSystemPrompt();
  const userPrompt = buildSuperiorReviewUserPrompt(request);
  const result = await chat([{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: 1024,
    temperature: 0.1,
    agent: name,
    purpose: 'superior_review',
    sessionId: 'system',
    correlationId: trackingId,
  });
  return parseSuperiorReviewResult(
    result.content,
    request.delegationId,
    request.superiorId,
    request.correlationId,
  );
}
