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
}

export interface DraftResponsePayload {
  sessionId: string;
  draft: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; input: string; result: string }>;
}

export interface FinalResponsePayload {
  sessionId: string;
  response: string;
  reviewVerdict: ReviewVerdict;
}
