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

/**
 * WebSocket 客户端连接抽象接口。
 * 用于外部 runtime driver（如 CustomDriver）连接外部 AI 服务端点，
 * 使 kernel 不直接依赖 ws 模块。
 */
export interface WsClientConnection {
  /** 发送文本数据 */
  send(data: string): void;
  /** 关闭连接 */
  close(code?: number, reason?: string): void;
  /**
   * 注册事件处理器。
   * event 类型：open / close（无参数）、message（data 负载）、error（Error 对象）
   */
  on(event: 'open' | 'close' | 'message' | 'error', handler: (...args: unknown[]) => void): void;
}

/** WebSocket 客户端工厂函数：根据 URL 和 headers 创建连接 */
export type WsClientFactory = (url: string, headers: Record<string, string>) => Promise<WsClientConnection>;

export interface ProviderConfig {
  endpoint?: string;
  protocol?: 'http' | 'ws';
  apiKey?: string;
  model?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  args?: string[];
  timeout?: number;
  /** 注入的 WebSocket 客户端工厂，避免 kernel 直接 import('ws') */
  wsClientFactory?: WsClientFactory;
}
