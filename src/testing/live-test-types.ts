import type { Span } from '../observability/tracer.js';

export interface ModelRequestFilter {
  agent?: string;
  purpose?: string;
  status?: 'pending' | 'responded' | 'failed';
  modelTier?: 'fast' | 'default' | 'high';
  sessionId?: string;
}

export interface ModelRequestRecord {
  id: string;
  agent: string;
  purpose: string;
  modelTier: string;
  modelName: string | null;
  mode: string;
  status: string;
  latencyMs: number | null;
  requestPayload: {
    system?: string;
    messages: unknown[];
    tools?: unknown[];
  };
  responsePayload: {
    content: string;
    toolCalls?: unknown[];
    usage?: { inputTokens: number; outputTokens: number };
  } | null;
  error: string | null;
  createdAt: number;
}

export interface IOEntry {
  ts: number;
  direction: 'in' | 'out';
  type: string;
  payload: Record<string, unknown>;
}

export interface SpanTreeNode {
  span: Span;
  children: SpanTreeNode[];
}

export interface LiveTestContextOptions {
  debugOnFailure?: boolean;
}

export interface LogEntry {
  ts: number;
  level: 'error' | 'warn' | 'info' | 'debug';
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface EventEntry {
  ts: number;
  event: string;
  payload: Record<string, unknown>;
}

export interface TestDebugDump {
  spanTree: SpanTreeNode[];
  modelRequests: ModelRequestRecord[];
  ioTranscript: IOEntry[];
  logs: LogEntry[];
  events: EventEntry[];
  timing: { totalMs: number; llmMs: number; overheadMs: number };
}

export interface StreamingChunk {
  type: 'progress' | 'text_delta' | 'result' | 'error';
  raw: Record<string, unknown>;
  receivedAt: number;
}

export interface StreamingResult {
  chunks: StreamingChunk[];
  finalResponse: string;
  sessionId: string;
  taskId: string;
  progressEvents: Array<{ status: string; summary: string }>;
  textDeltas: string[];
  totalChunks: number;
  firstChunkMs: number;
  totalMs: number;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  taskType: string;
  targetAgent: string;
  status: string;
  priority: number;
  createdAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface TaskFilter {
  sessionId?: string;
  targetAgent?: string;
  taskType?: string;
  status?: string;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  counters: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
  histograms: Record<string, Array<{ labels: Record<string, string>; count: number; p50: number; p95: number; p99: number }>>;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  agent: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  isError: boolean;
  permissionVerdict: string | null;
  dangerLevel: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface ToolCallFilter {
  sessionId?: string;
  taskId?: string;
  toolName?: string;
  agent?: string;
  isError?: boolean;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  kind: string;
  requester: string;
  riskLevel: string;
  status: string;
  decisionSource: string | null;
  reason: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ApprovalFilter {
  sessionId?: string;
  kind?: string;
  status?: string;
  riskLevel?: string;
}
