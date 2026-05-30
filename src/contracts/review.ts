import type { RouteDecision } from './routing.js';

export type ReviewVerdict = 'approve' | 'modify' | 'reject';
export type ReviewLevel = 'A' | 'B' | 'C';

export interface TurnRecord {
  sessionId: string;
  userMessage: string;
  draftResponse: string;
  toolCalls: Array<{ name: string; input: string; result: string }>;
  level: ReviewLevel;
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

export function classifyLevel(turn: TurnRecord): ReviewLevel {
  if (turn.toolCalls.length > 0) return 'B';
  const inputLength = turn.userMessage.length + turn.draftResponse.length;
  if (inputLength <= 800) return 'A';
  if (inputLength <= 3200) return 'B';
  return 'C';
}
