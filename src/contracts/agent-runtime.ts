export type RuntimeProvider = 'builtin' | 'claude_code' | 'opencode' | 'hermes' | 'custom';

export type AgentEventKind =
  | 'text_delta'
  | 'text_done'
  | 'thinking_delta'
  | 'thinking_done'
  | 'tool_pending'
  | 'tool_running'
  | 'tool_completed'
  | 'tool_failed'
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed'
  | 'execution_cancelled'
  | 'question_asked'
  | 'permission_requested'
  | 'phase_changed'
  | 'progress'
  | 'checkpoint_saved';

export interface AgentEvent {
  kind: AgentEventKind;
  executionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface RuntimeCapabilities {
  toolInterception: boolean;
  streaming: boolean;
  fileAccess: boolean;
  multiTurn: boolean;
  resumable: boolean;
  maxContextTokens?: number;
}

export interface ExecutionTask {
  executionId: string;
  prompt: string;
  systemPrompt?: string;
  workspacePath?: string;
  context?: string;
  files?: string[];
  env?: Record<string, string>;
  args?: string[];
  timeout?: number;
  thinkingLevel?: string;
  sessionId?: string;
  model?: string;
  maxTurns?: number;
  traceId?: string;
}

export interface AgentRuntime {
  readonly name: string;
  readonly provider: RuntimeProvider;
  getCapabilities(): RuntimeCapabilities;
  execute(task: ExecutionTask): AsyncGenerator<AgentEvent>;
  cancel(executionId: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}

export interface ProviderConfig {
  endpoint?: string;
  protocol?: 'http' | 'ws';
  apiKey?: string;
  model?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  args?: string[];
  timeout?: number;
}
