export interface TaskAcknowledgePayload {
  taskId: string;
}

export interface AgentTaskPayload {
  taskId: string;
  sessionId: string;
  taskType: string;
  inputPayload: Record<string, unknown>;
  modelTier?: import('./model.js').ModelTier;
  /** 13.0 §12.2: 任务关联的 mission ID（Brain 路由时设置，透传给 agent） */
  missionId?: string;
  /** 13.0 §12.2: 任务关联的 plan task ID（如 t-1、t-2） */
  planTaskId?: string;
}

export interface AgentTaskResultPayload {
  taskId: string;
  ok: boolean;
  outputPayload?: Record<string, unknown>;
  error?: string;
}

export interface TaskStartedPayload {
  taskId: string;
}

export interface TaskProgressPayload {
  taskId: string;
  summary: string;
}

export type TaskTelemetryPayload =
  | { kind: 'text_delta'; taskId: string; text: string }
  | { kind: 'reasoning_delta'; taskId: string; text: string }
  | { kind: 'llm_completed'; taskId: string; agentName: string; inputTokens: number; outputTokens: number; cacheRead?: number; cacheCreation?: number; durationMs: number }
  | { kind: 'tool_result'; taskId: string; toolName: string; isError: boolean }
  | { kind: 'tool_call'; taskId: string; toolName: string; input: string; result: string; isError: boolean; durationMs: number }
  | { kind: 'uncertainty'; taskId: string; reason: string };
