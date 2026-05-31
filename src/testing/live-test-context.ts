import type Database from 'better-sqlite3';
import { MemorySink, getTracer, type Span } from '../observability/tracer.js';
import { setRunLogCallback } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { IpcCapture, type CapturedMessage, type CaptureFilter } from './ipc-capture.js';
import type {
  ModelRequestFilter,
  ModelRequestRecord,
  IOEntry,
  LogEntry,
  EventEntry,
  SpanTreeNode,
  LiveTestContextOptions,
  TestDebugDump,
  TaskRecord,
  TaskFilter,
  MetricsSnapshot,
  ToolCallRecord,
  ToolCallFilter,
  ApprovalRecord,
  ApprovalFilter,
} from './live-test-types.js';

export class LiveTestContext {
  private memorySink: MemorySink;
  private ioLog: IOEntry[] = [];
  private logEntries: LogEntry[] = [];
  private eventEntries: EventEntry[] = [];
  private ipcCapture: IpcCapture;
  private db: Database.Database;
  private startTime: number;
  private debugOnFailure: boolean;

  constructor(db: Database.Database, options?: LiveTestContextOptions) {
    this.db = db;
    this.startTime = Date.now();
    this.debugOnFailure = options?.debugOnFailure ?? !!process.env.BERRY_TEST_DEBUG;
    this.memorySink = new MemorySink();
    this.ipcCapture = new IpcCapture(db);
    getTracer().addSink(this.memorySink.sink);

    setRunLogCallback((level, module, msg, data) => {
      this.logEntries.push({ ts: Date.now() - this.startTime, level, module, msg, data });
    });
  }

  // --- Span Access ---

  getSpans(): Span[] {
    return this.memorySink.spans;
  }

  getSpanTree(): SpanTreeNode[] {
    return buildSpanTree(this.memorySink.spans);
  }

  getSpansByName(name: string): Span[] {
    return this.memorySink.spans.filter(s => s.name === name);
  }

  getSpansByAttribute(key: string, value?: string | number | boolean): Span[] {
    return this.memorySink.spans.filter(s => {
      if (value === undefined) return key in s.attributes;
      return s.attributes[key] === value;
    });
  }

  // --- Model Request Inspector ---

  getModelRequests(filter?: ModelRequestFilter): ModelRequestRecord[] {
    let sql = 'SELECT * FROM model_requests WHERE created_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.agent) { sql += ' AND agent_name = ?'; params.push(filter.agent); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.modelTier) { sql += ' AND model_tier = ?'; params.push(filter.modelTier); }
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.purpose) { sql += ' AND purpose = ?'; params.push(filter.purpose); }
    sql += ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  getLastRequest(): ModelRequestRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM model_requests WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1',
    ).get(this.startTime) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  countRequests(filter?: ModelRequestFilter): number {
    let sql = 'SELECT COUNT(*) as cnt FROM model_requests WHERE created_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.agent) { sql += ' AND agent_name = ?'; params.push(filter.agent); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.modelTier) { sql += ' AND model_tier = ?'; params.push(filter.modelTier); }
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.purpose) { sql += ' AND purpose = ?'; params.push(filter.purpose); }
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  getTotalTokens(): { input: number; output: number; total: number } {
    const requests = this.getModelRequests({ status: 'responded' });
    let input = 0;
    let output = 0;
    for (const r of requests) {
      input += r.responsePayload?.usage?.inputTokens ?? 0;
      output += r.responsePayload?.usage?.outputTokens ?? 0;
    }
    return { input, output, total: input + output };
  }

  getTotalLlmLatency(): number {
    const requests = this.getModelRequests({ status: 'responded' });
    let total = 0;
    for (const r of requests) {
      total += r.latencyMs ?? 0;
    }
    return total;
  }

  // --- I/O Recording ---

  recordIO(direction: 'in' | 'out', type: string, payload: Record<string, unknown>): void {
    this.ioLog.push({ ts: Date.now() - this.startTime, direction, type, payload });
  }

  getIOTranscript(): IOEntry[] {
    return this.ioLog;
  }

  // --- Log Capture ---

  getLogs(filter?: { module?: string; level?: string }): LogEntry[] {
    let entries = this.logEntries;
    if (filter?.module) {
      entries = entries.filter(e => e.module === filter.module);
    }
    if (filter?.level) {
      entries = entries.filter(e => e.level === filter.level);
    }
    return entries;
  }

  getLogErrors(): LogEntry[] {
    return this.logEntries.filter(e => e.level === 'error');
  }

  // --- Event Recording ---

  recordEvent(event: string, payload: Record<string, unknown>): void {
    this.eventEntries.push({ ts: Date.now() - this.startTime, event, payload });
  }

  getEvents(filter?: { event?: string }): EventEntry[] {
    if (filter?.event) {
      return this.eventEntries.filter(e => e.event === filter.event);
    }
    return this.eventEntries;
  }

  // --- Agent Task Lifecycle ---

  getAgentTasks(filter?: TaskFilter): TaskRecord[] {
    let sql = 'SELECT * FROM agent_tasks WHERE created_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.targetAgent) { sql += ' AND target_agent = ?'; params.push(filter.targetAgent); }
    if (filter?.taskType) { sql += ' AND task_type = ?'; params.push(filter.taskType); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    sql += ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(row => this.mapTaskRow(row));
  }

  getTaskTimeline(sessionId?: string): TaskRecord[] {
    return this.getAgentTasks(sessionId ? { sessionId } : undefined);
  }

  // --- Metrics ---

  getMetricsSnapshot(): MetricsSnapshot {
    return metrics.snapshot();
  }

  // --- Tool Calls ---

  getToolCalls(filter?: ToolCallFilter): ToolCallRecord[] {
    let sql = 'SELECT * FROM tool_calls WHERE started_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.taskId) { sql += ' AND task_id = ?'; params.push(filter.taskId); }
    if (filter?.toolName) { sql += ' AND tool_name = ?'; params.push(filter.toolName); }
    if (filter?.agent) { sql += ' AND agent_name = ?'; params.push(filter.agent); }
    if (filter?.isError !== undefined) { sql += ' AND is_error = ?'; params.push(filter.isError ? 1 : 0); }
    sql += ' ORDER BY started_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(row => this.mapToolCallRow(row));
  }

  countToolCalls(filter?: ToolCallFilter): number {
    let sql = 'SELECT COUNT(*) as cnt FROM tool_calls WHERE started_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.taskId) { sql += ' AND task_id = ?'; params.push(filter.taskId); }
    if (filter?.toolName) { sql += ' AND tool_name = ?'; params.push(filter.toolName); }
    if (filter?.agent) { sql += ' AND agent_name = ?'; params.push(filter.agent); }
    if (filter?.isError !== undefined) { sql += ' AND is_error = ?'; params.push(filter.isError ? 1 : 0); }
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  // --- Approval Requests ---

  getApprovalRequests(filter?: ApprovalFilter): ApprovalRecord[] {
    let sql = 'SELECT * FROM approval_requests WHERE created_at >= ?';
    const params: unknown[] = [this.startTime];
    if (filter?.sessionId) { sql += ' AND session_id = ?'; params.push(filter.sessionId); }
    if (filter?.kind) { sql += ' AND kind = ?'; params.push(filter.kind); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.riskLevel) { sql += ' AND risk_level = ?'; params.push(filter.riskLevel); }
    sql += ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      taskId: (row.task_id as string) ?? null,
      kind: row.kind as string,
      requester: row.requester as string,
      riskLevel: row.risk_level as string,
      status: row.status as string,
      decisionSource: (row.decision_source as string) ?? null,
      reason: (row.reason as string) ?? null,
      createdAt: row.created_at as number,
      resolvedAt: (row.resolved_at as number) ?? null,
    }));
  }

  // --- IPC ---

  getIpcMessages(filter?: CaptureFilter): CapturedMessage[] {
    return this.ipcCapture.getAll(filter);
  }

  getIpcFlow(correlationId: string): CapturedMessage[] {
    return this.ipcCapture.getFlow(correlationId);
  }

  // --- Debug Dump ---

  buildDebugDump(): TestDebugDump {
    const modelRequests = this.getModelRequests();
    const llmMs = this.getTotalLlmLatency();
    const totalMs = Date.now() - this.startTime;
    return {
      spanTree: this.getSpanTree(),
      modelRequests,
      ioTranscript: this.ioLog,
      logs: this.logEntries,
      events: this.eventEntries,
      timing: { totalMs, llmMs, overheadMs: totalMs - llmMs },
    };
  }

  buildDebugDumpJSON(): Record<string, unknown> {
    const dump = this.buildDebugDump();
    return {
      spans: this.memorySink.spans,
      spanTree: serializeSpanTree(dump.spanTree),
      modelRequests: dump.modelRequests,
      ioTranscript: dump.ioTranscript,
      logs: dump.logs,
      events: dump.events,
      agentTasks: this.getAgentTasks(),
      metrics: this.getMetricsSnapshot(),
      timing: dump.timing,
    };
  }

  dumpOnFailure(testName: string): void {
    if (!this.debugOnFailure) return;
    const dump = this.buildDebugDump();
    process.stderr.write(`\n${'='.repeat(60)}\n`);
    process.stderr.write(`DEBUG DUMP: ${testName}\n`);
    process.stderr.write(`${'='.repeat(60)}\n`);
    process.stderr.write(formatDebugDump(dump));
    process.stderr.write(`\n${'='.repeat(60)}\n\n`);
  }

  reset(): void {
    this.memorySink.clear();
    this.ioLog.length = 0;
    this.logEntries.length = 0;
    this.eventEntries.length = 0;
    this.startTime = Date.now();
  }

  dispose(): void {
    setRunLogCallback(null);
  }

  private mapRow(row: Record<string, unknown>): ModelRequestRecord {
    const createdAt = row.created_at as number;
    const respondedAt = row.responded_at as number | null;
    let responsePayload: ModelRequestRecord['responsePayload'] = null;
    if (row.response_payload && typeof row.response_payload === 'string') {
      try { responsePayload = JSON.parse(row.response_payload); } catch {}
    }
    let requestPayload: ModelRequestRecord['requestPayload'] = { messages: [] };
    if (row.request_payload && typeof row.request_payload === 'string') {
      try { requestPayload = JSON.parse(row.request_payload); } catch {}
    }
    return {
      id: row.id as string,
      agent: row.agent_name as string,
      purpose: row.purpose as string,
      modelTier: row.model_tier as string,
      modelName: (row.model_name as string) ?? null,
      mode: row.mode as string,
      status: row.status as string,
      latencyMs: respondedAt != null ? respondedAt - createdAt : null,
      requestPayload,
      responsePayload,
      error: (row.error as string) ?? null,
      createdAt,
    };
  }

  private mapTaskRow(row: Record<string, unknown>): TaskRecord {
    const createdAt = row.created_at as number;
    const finishedAt = row.finished_at as number | null;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      taskType: row.task_type as string,
      targetAgent: row.target_agent as string,
      status: row.status as string,
      priority: row.priority as number,
      createdAt,
      dispatchedAt: (row.dispatched_at as number) ?? null,
      startedAt: (row.started_at as number) ?? null,
      finishedAt,
      durationMs: finishedAt != null ? finishedAt - createdAt : null,
      error: (row.error as string) ?? null,
    };
  }

  private mapToolCallRow(row: Record<string, unknown>): ToolCallRecord {
    const startedAt = row.started_at as number;
    const finishedAt = (row.finished_at as number) ?? null;
    let input: Record<string, unknown> = {};
    if (row.input && typeof row.input === 'string') {
      try { input = JSON.parse(row.input); } catch {}
    }
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      taskId: (row.task_id as string) ?? null,
      agent: row.agent_name as string,
      toolName: row.tool_name as string,
      input,
      result: (row.result as string) ?? null,
      isError: !!(row.is_error as number),
      permissionVerdict: (row.permission_verdict as string) ?? null,
      dangerLevel: (row.danger_level as string) ?? null,
      startedAt,
      finishedAt,
      durationMs: finishedAt != null ? finishedAt - startedAt : null,
    };
  }
}

export function buildSpanTree(spans: Span[]): SpanTreeNode[] {
  const nodes = new Map<string, SpanTreeNode>();
  for (const span of spans) {
    nodes.set(span.id, { span, children: [] });
  }
  const roots: SpanTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.span.parentId && nodes.has(node.span.parentId)) {
      nodes.get(node.span.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function serializeSpanTree(nodes: SpanTreeNode[]): unknown[] {
  return nodes.map(node => ({
    name: node.span.name,
    id: node.span.id,
    traceId: node.span.traceId,
    status: node.span.status,
    durationMs: node.span.endTime ? node.span.endTime - node.span.startTime : null,
    attributes: node.span.attributes,
    error: node.span.error,
    children: serializeSpanTree(node.children),
  }));
}

export function formatDebugDump(dump: TestDebugDump): string {
  const parts: string[] = [];

  parts.push('\n--- SPAN TREE ---');
  if (dump.spanTree.length === 0) {
    parts.push('  (no spans captured)');
  } else {
    formatSpanNodes(dump.spanTree, parts, 0);
  }

  parts.push('\n--- MODEL REQUESTS (' + dump.modelRequests.length + ') ---');
  for (let i = 0; i < dump.modelRequests.length; i++) {
    const r = dump.modelRequests[i];
    const tokens = r.responsePayload?.usage
      ? `${r.responsePayload.usage.inputTokens}+${r.responsePayload.usage.outputTokens}tok`
      : '-';
    const latency = r.latencyMs != null ? `${r.latencyMs}ms` : '-';
    parts.push(`  #${i + 1}  ${r.agent}  ${r.purpose}  ${r.modelTier}  ${tokens}  ${latency}  ${r.status}`);
  }

  parts.push('\n--- I/O TRANSCRIPT ---');
  for (const entry of dump.ioTranscript) {
    const arrow = entry.direction === 'in' ? '→' : '←';
    const time = (entry.ts / 1000).toFixed(3);
    const payloadStr = JSON.stringify(entry.payload).slice(0, 120);
    parts.push(`  ${time}s ${arrow} ${payloadStr}`);
  }

  const errorLogs = dump.logs.filter(e => e.level === 'error' || e.level === 'warn');
  if (errorLogs.length > 0) {
    parts.push('\n--- LOGS (errors/warns: ' + errorLogs.length + ') ---');
    for (const entry of errorLogs) {
      const time = (entry.ts / 1000).toFixed(3);
      parts.push(`  ${time}s [${entry.level}] ${entry.module}: ${entry.msg}`);
    }
  }

  if (dump.events.length > 0) {
    parts.push('\n--- EVENTS (' + dump.events.length + ') ---');
    for (const entry of dump.events) {
      const time = (entry.ts / 1000).toFixed(3);
      const payloadStr = JSON.stringify(entry.payload).slice(0, 100);
      parts.push(`  ${time}s ${entry.event} ${payloadStr}`);
    }
  }

  parts.push('\n--- TIMING ---');
  parts.push(`  Total: ${dump.timing.totalMs}ms | LLM: ${dump.timing.llmMs}ms | Overhead: ${dump.timing.overheadMs}ms`);

  return parts.join('\n');
}

function formatSpanNodes(nodes: SpanTreeNode[], parts: string[], depth: number): void {
  const indent = '  '.repeat(depth + 1);
  for (const node of nodes) {
    const dur = node.span.endTime ? `${node.span.endTime - node.span.startTime}ms` : 'running';
    const attrs = Object.entries(node.span.attributes)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const attrStr = attrs ? ` (${attrs})` : '';
    parts.push(`${indent}[${dur}] ${node.span.name}${attrStr}`);
    if (node.children.length > 0) {
      formatSpanNodes(node.children, parts, depth + 1);
    }
  }
}
