export type DelegationState =
  | 'routing'
  | 'delegated'
  | 'active'
  | 'awaiting_user'
  | 'reviewing'
  | 'completed'
  | 'failed';

export function isDelegationTerminal(state: DelegationState): boolean {
  return state === 'completed' || state === 'failed';
}

export interface DelegationMetrics {
  toolCallCount: number;
  tokenUsed: { input: number; output: number };
  consecutiveToolFailures: number;
  sameToolRepeatCount: number;
  lastToolName: string | null;
  checkpointCount: number;
}

export interface DelegationBudget {
  maxOutputTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxReRouteDepth: number;
}

export const DEFAULT_INTERNAL_BUDGET: DelegationBudget = {
  maxOutputTokens: 50_000,
  maxToolCalls: 30,
  maxDurationMs: 300_000,
  maxReRouteDepth: 2,
};

export const DEFAULT_EXTERNAL_BUDGET: DelegationBudget = {
  maxOutputTokens: 50_000,
  maxToolCalls: 30,
  maxDurationMs: 600_000,
  maxReRouteDepth: 2,
};

/**
 * 13.0 §5.3.11: 任务交接上下文 — handoff 时把当前 Agent 的工作状态结构化传给接班 Agent。
 *
 * 接班的 Agent 在 entry 处读取 HandoffContext 并拼接到 system prompt，
 * 避免「无状态 Agent 不知道之前干了什么」导致的重复劳动或上下文丢失。
 */
export interface HandoffContext {
  /** 原始用户指令（这一串工作最初的诉求） */
  originalInstruction: string;
  /** 意图锚（12.0 Intent Anchor，限定任务语义边界） */
  intentAnchor?: {
    goal: string;
    successCriteria: string[];
    scope: { include?: string[]; exclude?: string[] };
  };
  /** 接班的 Agent 已经读过的文件路径（避免重复读） */
  filesRead: string[];
  /** 接班的 Agent 已经修改过的文件路径（含 diff hash 让接班者理解改了什么） */
  filesModified: Array<{ path: string; diffHash?: string }>;
  /** 接班的 Agent 与其他 agent 的对话历史（最近 N 条，给接班者体感） */
  agentConversations: Array<{ with: string; summary: string; at: number }>;
  /** 当前进度（自然语言描述） */
  currentProgress: string;
  /** 已知阻塞（blocker 列表，Brain/leader 可读） */
  blockers: Array<{ reason: string; raisedAt: number; raisedBy: string }>;
  /** 当前 scope 快照（active blockPaths/blockTools） */
  scopeSnapshot?: {
    blockPaths: string[];
    blockTools: string[];
  };
  /** handoff 时间 */
  handoffAt: number;
  /** 交接发起方 */
  fromAgent: string;
}

export interface TurnOutputPayload {
  delegationId: string;
  kind: 'text_delta' | 'progress' | 'tool_result' | 'tool_error' | 'usage' | 'llm_completed';
  data: unknown;
}

export interface TurnFinalPayload {
  delegationId: string;
  response: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown; result?: string }>;
  totalUsage?: { inputTokens: number; outputTokens: number };
  metadata?: Record<string, unknown>;
  /** 13.0 §5.3.11: handoff 时携带的结构化上下文（下一棒 agent 接手时读取） */
  handoffContext?: HandoffContext;
}

export type ReviewOrigin = 'conversation' | 'task' | 'superior_chain';

export interface DelegationEntry {
  id: string;
  state: DelegationState;
  sessionId: string;
  correlationId: string;
  targetAgent: string;
  targetKind: 'internal' | 'daemon';
  userMessage: string;
  routeInstruction?: string;
  reviewOrigin?: ReviewOrigin;
  createdAt: number;
  reRouteDepth: number;
  metrics: DelegationMetrics;
  outputs: TurnOutputPayload[];
  finalResponse?: string;
  parentId?: string;
  budget: DelegationBudget;
  budgetWarningTriggered?: boolean;
  lastCheckpointAt?: number;
  forbiddenTools?: string[];
  workspaceId?: string;
  delegationType?: 'agent' | 'workspace';
  /** 13.0 多智能体协作：关联的 mission ID（Brain 路由时设置） */
  missionId?: string;
  /** 13.0 多智能体协作：关联的 plan task ID（plan.json 中的任务编号） */
  planTaskId?: string;
  /** 13.0 §11: 当前 squad ID（用于 squad 上下文注入） */
  squadId?: string;
  /** 13.0 §11: 当前 squad role（lead / work / check） */
  squadRole?: 'lead' | 'work' | 'check';
  /** 13.0 §5.3.11: handoff 时附带的结构化上下文 */
  handoffContext?: HandoffContext;
}

export interface DelegationGroup {
  parentId: string;
  childIds: Set<string>;
  completedResults: Map<string, { agentName: string; response: string }>;
  correlationId: string;
  sessionId: string;
  createdAt: number;
}

export interface CreateDelegationParams {
  sessionId: string;
  correlationId: string;
  targetAgent: string;
  targetKind: 'internal' | 'daemon';
  userMessage: string;
  taskType: string;
  requester: string;
  inputPayload: Record<string, unknown>;
  foreground: boolean;
  reRouteDepth?: number;
  parentId?: string;
  budget?: Partial<DelegationBudget>;
  workspaceId?: string;
  delegationType?: 'agent' | 'workspace';
}

export type GuardAction =
  | { type: 'none' }
  | { type: 'terminate'; reason: string }
  | { type: 'checkpoint'; trigger: string };

// --- Layer 3: Semantic Correction Types ---

export type CheckpointTrigger =
  | 'consecutive_tool_failures'
  | 'same_tool_repeat'
  | 'budget_warning'
  | 'agent_uncertainty'
  | 'user_interrupt'
  | 'semantic_drift';

export interface CorrectionContext {
  userMessage: string;
  routeInstruction: string;
  metrics: DelegationMetrics;
  budget: DelegationBudget;
  recentOutputs: string[];
  failedTools: Array<{ name: string; error: string; count: number }>;
  interruptMessage?: string;
}

export interface TurnCheckpointPayload {
  delegationId: string;
  trigger: CheckpointTrigger;
  context: CorrectionContext;
}

export type CorrectionAction = 'continue' | 'adjust' | 'stop' | 'restart';

export interface CorrectionConstraints {
  maxRemainingTokens?: number;
  forbiddenTools?: string[];
  requiredApproach?: string;
  reducedTimeout?: number;
}

export interface TurnCorrectionPayload {
  delegationId: string;
  action: CorrectionAction;
  instruction?: string;
  newConstraints?: CorrectionConstraints;
  /** L2: CAS 消费 ID，防止崩溃后重复注入 */
  _correctionId?: string | null;
  /** L2: 消费时间戳，调用方可做幂等判断 */
  _consumedAt?: number;
}

export const CORRECTION_LIMITS = {
  maxCheckpointsPerDelegation: 3,
  minIntervalMs: 10_000,
  maxCorrectionTokens: 2000,
  budgetFraction: 0.15,
};
