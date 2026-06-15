/**
 * 简单 brain handler 核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * agent.ask_user + superior.review.request + drift.check + verify——single-LLM-call handlers。
 * 共享状态最小（仅 llm/name），提取为纯函数，entry.ts 保留 ipc.onMessage/send 薄包装。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { AgentAskUserPayload } from '../../../contracts/routing.js';
import type { SuperiorReviewRequest } from '../../../contracts/superior-review.js';
import type { DriftCheckRequestPayload } from '../../../kernel/drift-detector.js';
import type { IntentAnchor } from '../../../contracts/intent.js';
import { safeSlice } from '../../../utils/safe-slice.js';
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

/**
 * drift.check.request 核心逻辑（语义漂移检测——判断回复是否偏离用户意图）。
 * 动态 import drift-detector 避免循环依赖（brain → kernel/drift-detector）。
 */
export async function evaluateDriftCheck(
  payload: DriftCheckRequestPayload,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
  const { buildDriftCheckPrompt, parseDriftCheckResult } = await import('../../../kernel/drift-detector.js');
  const prompt = buildDriftCheckPrompt(payload.anchor, payload.content, payload.checkpointType);
  const result = await chat([{ role: 'user', content: prompt }], {
    system: '你是语义对齐检测器。只输出 JSON，不要有任何其他文本。',
    maxTokens: 200, temperature: 0, agent: name, purpose: 'drift_detection',
    sessionId: undefined, correlationId: trackingId,
  });
  return parseDriftCheckResult(result.content, payload.checkpointType);
}

/**
 * verify.request 核心逻辑（Verify Gate——独立对抗性意图验证）。
 * 内联 prompt + JSON 解析（无 prompts.ts 依赖——该 handler 是自包含的）。
 */
export async function evaluateVerify(
  anchor: IntentAnchor,
  draftResponse: string,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
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

  const result = await chat([{ role: 'user', content: verifyPrompt }], {
    system: '你是独立意图验证器，以对抗性视角审视回复是否真正解决了用户问题。只输出 JSON。',
    maxTokens: 300, temperature: 0, agent: name, purpose: 'brain_review',
    modelTier: 'default', sessionId: undefined, correlationId: trackingId,
  });

  // 内联 JSON 解析（自包含，不依赖外部 parser）
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
  return verdict;
}
