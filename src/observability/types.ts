export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type OutputMode = 'human' | 'json' | 'jsonl';
export type ConsoleStream = 'stdout' | 'stderr';

export interface LogEvent {
  ts: number;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
  runId?: string;
  correlationId?: string;
  spanId?: string;
}

export interface ConsoleFrame {
  ts: number;
  seq: number;
  stream: ConsoleStream;
  source: string;
  level?: LogLevel;
  isJson: boolean;
  text?: string;
  payload?: unknown;
  runId: string;
}

export interface RunArtifact {
  runId: string;
  kind: 'cli' | 'test' | 'service' | 'agent' | 'plugin';
  sessionId?: string;
  command?: string;
  artifactDir: string;
  logLevel: LogLevel;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
}
