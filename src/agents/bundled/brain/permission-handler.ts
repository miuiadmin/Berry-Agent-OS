/**
 * permission.judge 核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * LLM 权限判断：评估工具调用是否安全（allowed/reason）。
 * systemPrompt 由 entry.ts 构造（含 recallInsights/recallDecisions 闭包），本函数只做
 * buildUserPrompt → chat → parsePermissionJudge。entry.ts 保留 ipc + recordPermissionDecision。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { PermissionJudgeRequestPayload } from '../../../contracts/routing.js';
import { buildPermissionJudgeUserPrompt, parsePermissionJudge } from './prompts.js';

type ChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/**
 * permission.judge LLM 调用 + 解析。
 * @param payload      权限判断请求
 * @param systemPrompt 已构造好的 system prompt（entry.ts 注入 insights + decisions）
 * @param chat         LLM chat 函数
 * @param name         brain agent 名
 * @param trackingId   IPC 跟踪 id
 * @returns parsePermissionJudge 的结果（allowed + reason + modifyInput 等）
 */
export async function evaluatePermissionJudge(
  payload: PermissionJudgeRequestPayload,
  systemPrompt: string,
  chat: ChatFn,
  name: string,
  trackingId?: string,
) {
  const userPrompt = buildPermissionJudgeUserPrompt(
    payload.toolName,
    payload.toolInput,
    payload.dangerLevel,
    payload.taskContext,
  );
  const result = await chat([{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: 1024,
    temperature: 0.0,
    agent: name,
    purpose: 'brain_permission',
    sessionId: payload.sessionId,
    correlationId: trackingId,
  });
  return parsePermissionJudge(result.content);
}
