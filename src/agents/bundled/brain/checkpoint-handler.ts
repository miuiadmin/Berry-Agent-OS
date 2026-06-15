/**
 * checkpoint 核心逻辑（架构升级 16.0 §17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * Layer 3 语义纠偏：评估任务是否偏离方向 → continue/adjust/stop/restart + command。
 * P4-B1：注入板上下文让 brain 看板下钻（§4.2 重监督 + §10.1 LLM 下钻）。
 *
 * 提取模式：核心逻辑（板上下文 + prompt + LLM 调用 + 解析）独立成函数，
 * entry.ts 保留 ipc.onMessage/send 薄包装——降低巨石行数 + 可独立单测。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import type { TurnCheckpointPayload } from '../../../contracts/delegation.js';
import { CORRECTION_LIMITS } from '../../../contracts/delegation.js';
import { getBoardContext } from '../../../kernel/board-repo.js';
import { renderBoardContext } from './board-context.js';
import { buildCheckpointSystemPrompt, buildCheckpointUserPrompt, parseCheckpointResult } from './prompts.js';

/**
 * checkpoint.evaluate 核心逻辑（不含 IPC 收发）。
 *
 * @param payload      checkpoint 请求（delegationId = board id）
 * @param chat         LLM chat 函数（entry.ts 传 (messages, opts) => llm.current.chat(...)）
 * @param name         brain agent 名
 * @param correlationId IPC 跟踪 id（LLM 调用 correlationId 用）
 * @returns parseCheckpointResult 的结果（含 action + 可选 command）
 */
export async function evaluateCheckpoint(
  payload: TurnCheckpointPayload,
  // options 用 any 避免与 LlmClient.chat 的 ChatOptions 结构兼容性问题（entry.ts 包装层保证类型安全）
  chat: (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>,
  name: string,
  correlationId?: string,
) {
  // P4-B1：注入板上下文（payload.delegationId=board id，§5.1），让 brain 纠偏时看到整块板
  const boardCtx = payload.delegationId ? getBoardContext(payload.delegationId) : null;
  const baseSystemPrompt = buildCheckpointSystemPrompt();
  const systemPrompt = boardCtx
    ? `${baseSystemPrompt}\n\n## 任务板上下文（你正在监督的板）\n${renderBoardContext(boardCtx)}`
    : baseSystemPrompt;
  const userPrompt = buildCheckpointUserPrompt(payload);

  const result = await llmChat(chat, [{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: CORRECTION_LIMITS.maxCorrectionTokens,
    temperature: 0.1,
    agent: name,
    purpose: 'brain_checkpoint',
    sessionId: 'system',
    correlationId,
  });

  return parseCheckpointResult(result.content, payload.delegationId);
}

/** 类型安全的 chat 调用包装（options 字段明确，避免 any 传播） */
async function llmChat(
  chat: (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>,
  messages: ModelMessage[],
  options: {
    system: string;
    maxTokens: number;
    temperature: number;
    agent: string;
    purpose: string;
    sessionId: string;
    correlationId?: string;
  },
): Promise<{ content: string }> {
  return chat(messages, options);
}
