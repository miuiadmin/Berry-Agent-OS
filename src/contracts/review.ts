import type { RouteDecision } from './routing.js';

export type ReviewVerdict = 'approve' | 'modify' | 'reject';
export type ReviewLevel = 'A' | 'B' | 'C';

/**
 * 审核记录 — 提交给 Brain 审核的完整上下文。
 *
 * 13.0 §12.6: 增加 mission 上下文，让 Brain 审核时知道
 * "你分配给这个 agent 的任务是什么"。
 */
export interface TurnRecord {
  sessionId: string;
  userMessage: string;
  draftResponse: string;
  toolCalls: Array<{ name: string; input: string; result: string }>;
  level: ReviewLevel;
  /** 13.0 §12.6: 关联的 mission ID（Brain 创建 mission 后注入） */
  missionId?: string;
  /** 13.0 §12.6: 关联的 plan 任务 ID（用于审核后更新 plan 状态） */
  planTaskId?: string;
  /** 13.0 §12.6: 分配给 agent 的任务描述（Brain 审核时判断"目标是否达成"） */
  taskDescription?: string;
}

export interface ReviewRequest {
  turn: TurnRecord;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  finalResponse?: string;
  reason?: string;
  reRoute?: RouteDecision;
}

/** 13.0 §3.5: 审核上下文分级 — 确定性规则（非 LLM 判断） */
export function classifyLevel(turn: TurnRecord): ReviewLevel {
  // C 级：有大量工具调用或跨 agent 对话（高风险操作）
  if (turn.toolCalls.length > 15) return 'C';
  // B 级：有工具调用（中等复杂度）
  if (turn.toolCalls.length > 0) return 'B';
  // B 级：有 mission 上下文（涉及多 agent 协作，需要更多审核）
  if (turn.missionId) return 'B';
  // B 级：总长度超过 800 字
  const inputLength = turn.userMessage.length + turn.draftResponse.length;
  if (inputLength > 800) return 'B';
  // A 级：简单文本回复
  return 'A';
}
