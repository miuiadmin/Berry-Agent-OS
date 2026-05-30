import type { DangerLevel } from '../utils/types.js';

// === Routing Intent ===

export type RoutingIntent = 'chat' | 'code' | 'skill_test' | 'learning' | 'plugin' | 'multi' | 'external' | 'workspace';

// === Route Request / Result ===

export interface RouteRequestPayload {
  sessionId: string;
  message: string;
  taskId: string;
  availableAgents: Array<{ name: string; taskTypes: string[]; description: string }>;
  sessionContext?: string;
}

export interface RouteDecision {
  intent: RoutingIntent;
  targetAgent: string;
  targetWorkspaceId?: string;
  confidence?: number;
  subDispatches?: Array<{ targetAgent: string; taskType: string; inputPayload: Record<string, unknown> }>;
  priority: 'low' | 'normal' | 'high';
  instruction?: string;
  contextHints?: Record<string, unknown>;
  reason: string;
}

export interface RouteResultPayload {
  decision: RouteDecision;
}

// === Permission Judge (Brain LLM) ===

export interface PermissionJudgeRequestPayload {
  sessionId: string;
  agentName: string;
  toolName: string;
  toolInput: string;
  dangerLevel: DangerLevel;
  taskContext?: string;
}

export interface PermissionJudgeResultPayload {
  allowed: boolean;
  reason: string;
  conditions?: string;
  correction?: {
    instruction?: string;
    forbidTools?: string[];
  };
}

// === Agent Ask User (multi-turn) ===

export interface AgentAskUserPayload {
  sessionId: string;
  taskId: string;
  question: string;
  options?: string[];
  context?: string;
}

export interface AgentUserReplyPayload {
  sessionId: string;
  taskId: string;
  reply: string;
}

// === Workspace Routing ===

export interface WorkspaceRouteDecision {
  targetWorkspaceId: string;
  targetAgent?: string;
  intent: string;
  confidence: number;
  instruction?: string;
}

export type GlobalRoutingResult =
  | { type: 'direct'; response: string }
  | { type: 'delegate'; targets: WorkspaceRouteDecision[] }
  | { type: 'ask_user'; question: string; options: string[] };
