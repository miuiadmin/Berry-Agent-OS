import type { DangerLevel } from '../utils/types.js';
import type { IntentAnchor } from './intent.js';

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
  // 6.0 additions
  capability?: string;
  extraCapabilities?: string[];
  scope?: { capabilities: string[]; constraints?: { pathPattern?: string; maxDangerLevel?: DangerLevel; maxInvocations?: number; ttlMs?: number } };
  setup?: Array<{ action: 'create_agent' | 'activate_skill' | 'enable_plugin'; params: unknown }>;
  modelTier?: 'fast' | 'default' | 'high';
  activeSkills?: string[];
  /** 12.0: Brain 路由时产出的用户意图结构化描述（供漂移检测用） */
  intentAnchor?: IntentAnchor;
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
