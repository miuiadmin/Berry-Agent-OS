// Normalized events emitted by external agent CLIs (Claude Code, OpenCode, etc.)
// All adapters map CLI-specific output to this unified format.

export type ExternalEventKind =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'session_start'
  | 'error'
  | 'usage'
  | 'completion';

export interface TextEventData {
  kind: 'text';
  text: string;
}

export interface ToolCallEventData {
  kind: 'tool_call';
  toolName: string;
  callId: string;
  input: Record<string, unknown>;
}

export interface ToolResultEventData {
  kind: 'tool_result';
  callId: string;
  output: string;
  success: boolean;
}

export interface ThinkingEventData {
  kind: 'thinking';
  text: string;
}

export interface SessionStartEventData {
  kind: 'session_start';
  sessionId: string;
}

export interface ErrorEventData {
  kind: 'error';
  message: string;
  code?: string;
}

export interface UsageEventData {
  kind: 'usage';
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CompletionEventData {
  kind: 'completion';
  text: string;
  success: boolean;
  sessionId?: string;
}

export type NormalizedEventData =
  | TextEventData
  | ToolCallEventData
  | ToolResultEventData
  | ThinkingEventData
  | SessionStartEventData
  | ErrorEventData
  | UsageEventData
  | CompletionEventData;

export interface NormalizedExternalEvent {
  kind: ExternalEventKind;
  timestamp: number;
  data: NormalizedEventData;
}
