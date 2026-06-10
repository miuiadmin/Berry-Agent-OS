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
  /** 13.0: Brain 判断任务复杂时创建的 mission ID（多 agent 协作） */
  missionId?: string;
  /** 13.0: Brain 路由时指定的当前 plan task ID（如 t-1, t-2）— 用于注入 squad role/context */
  planTaskId?: string;
  /** 13.0: Brain 路由时指定的 mission 分解方案（kernel 据此创建 mission） */
  missionSpec?: {
    goal: string;
    context: string;
    tasks: Array<{ what: string; who: string; depends_on?: string[] }>;
    /** 13.0: 任务对应的 squad role（让 agent 知道自己在这个 squad 里干什么） */
    squadRole?: 'lead' | 'work' | 'check';
  };
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
