import type { MemoryContextFrame } from './memory.js';
import type { ModelTier } from './model.js';
import type { ReviewVerdict } from './review.js';

export interface UserMessagePayload {
  sessionId: string;
  message: string;
  taskId?: string;
  systemPrompt?: string;
  contextFrames?: MemoryContextFrame[];
  modelTierOverride?: ModelTier;
  intent?: string;
  /**
   * 客户端消息 ID（可选）。由 web 前端在 outbox 暂存时生成，
   * 用于 kernel 入口 + conversation agent 的幂等去重。
   * 同一 clientMsgId 的多次落盘只会保留一行。
   */
  clientMsgId?: string;
}

export interface DraftResponsePayload {
  sessionId: string;
  draft: string;
  reasoning?: string;
}

export interface FinalResponsePayload {
  sessionId: string;
  response: string;
  reviewVerdict: ReviewVerdict;
  /** 13.0 灵魂版：Brain 审核 reason（modify/reject 时填充，前端展示） */
  reviewReason?: string;
  /** 13.0 灵魂版：Brain 修改前的原始初稿（modify/reject 时填充，前端可展示 diff） */
  originalDraft?: string;
}
