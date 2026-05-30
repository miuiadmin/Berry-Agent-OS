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
  | 'user_interrupt';

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
}

export const CORRECTION_LIMITS = {
  maxCheckpointsPerDelegation: 3,
  minIntervalMs: 10_000,
  maxCorrectionTokens: 2000,
  budgetFraction: 0.15,
};
