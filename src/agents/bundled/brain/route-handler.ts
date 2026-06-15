/**
 * route.request 核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * 意图分析 + 路由：brain 判断用户消息的 intent + targetAgent。
 * systemPrompt 由 entry.ts 构造（含 recallInsights/recallDecisions/mission 上下文/升级指令 闭包），
 * 本函数只做 buildUserPrompt → chat → parseRouteDecision。
 * entry.ts 保留 systemPrompt 构造 + mission 创建 + ipc + recordRouteDecision。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { RouteRequestPayload } from '../../../contracts/routing.js';
import { buildRoutingUserPrompt, parseRouteDecision } from './prompts.js';

type ChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/**
 * route.request LLM 调用 + 解析。
 * @param payload      路由请求（message + availableAgents + sessionContext）
 * @param systemPrompt 已构造好的 system prompt（entry.ts 注入 insights + missions + 升级指令）
 * @param chat         LLM chat 函数
 * @param name         brain agent 名
 * @param trackingId   IPC 跟踪 id
 * @returns parseRouteDecision 的结果（intent + targetAgent + missionSpec + escalation 等）
 */
export async function evaluateRoute(
  payload: RouteRequestPayload,
  systemPrompt: string,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
  const userPrompt = buildRoutingUserPrompt(
    payload.message,
    payload.availableAgents,
    payload.sessionContext,
  );
  const result = await chat([{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: 1024,
    temperature: 0.1,
    agent: name,
    purpose: 'brain_routing',
    sessionId: payload.sessionId,
    correlationId: trackingId,
  });
  return parseRouteDecision(result.content);
}
