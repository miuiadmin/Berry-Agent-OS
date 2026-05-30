import type { TestHarness, MessageResult } from './harness.js';
import { LiveTestContext } from './live-test-context.js';
import type { LiveTestContextOptions, ModelRequestFilter, StreamingResult, TaskFilter, ToolCallFilter, ApprovalFilter } from './live-test-types.js';
import type { EventName } from '../contracts/infrastructure.js';

const KEY_EVENTS: EventName[] = [
  'task.created', 'task.dispatched', 'task.started',
  'task.completed', 'task.failed', 'task.timeout',
  'agent.registered', 'agent.crashed',
];

export function createLiveContext(harness: TestHarness, options?: LiveTestContextOptions): LiveTestContext {
  const db = harness.getDb();
  const ctx = new LiveTestContext(db, options);
  harness.setLiveContext(ctx);

  const eventBus = harness.getEventBus();
  if (eventBus) {
    for (const event of KEY_EVENTS) {
      eventBus.on(event, (payload) => {
        ctx.recordEvent(event, payload as Record<string, unknown>);
      });
    }
  }

  return ctx;
}

export async function sendWithRetry(
  harness: TestHarness,
  ctx: LiveTestContext,
  message: string,
  opts?: { maxRetries?: number; backoffMs?: number; sessionId?: string },
): Promise<MessageResult> {
  const maxRetries = opts?.maxRetries ?? 2;
  const backoffMs = opts?.backoffMs ?? 2000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await harness.sendMessage(message, opts?.sessionId);
      return result;
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;
      const isRetryable = msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('rate');
      if (!isRetryable || attempt === maxRetries) break;
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }

  throw lastError!;
}

export function assertTokenBudget(
  ctx: LiveTestContext,
  bounds: { maxInput?: number; maxOutput?: number; maxTotal?: number },
): void {
  const tokens = ctx.getTotalTokens();
  if (bounds.maxInput !== undefined && tokens.input > bounds.maxInput) {
    throw new Error(`Token budget exceeded: input ${tokens.input} > max ${bounds.maxInput}`);
  }
  if (bounds.maxOutput !== undefined && tokens.output > bounds.maxOutput) {
    throw new Error(`Token budget exceeded: output ${tokens.output} > max ${bounds.maxOutput}`);
  }
  if (bounds.maxTotal !== undefined && tokens.total > bounds.maxTotal) {
    throw new Error(`Token budget exceeded: total ${tokens.total} > max ${bounds.maxTotal}`);
  }
}

export function assertLatencyBound(
  ctx: LiveTestContext,
  maxMs: number,
  filter?: ModelRequestFilter,
): void {
  const requests = ctx.getModelRequests(filter);
  for (const r of requests) {
    if (r.latencyMs !== null && r.latencyMs > maxMs) {
      throw new Error(
        `Latency bound exceeded: request ${r.id} (${r.agent}/${r.purpose}) took ${r.latencyMs}ms > max ${maxMs}ms`,
      );
    }
  }
}

export function assertModelCallCount(
  ctx: LiveTestContext,
  expected: number | { min?: number; max?: number },
  filter?: ModelRequestFilter,
): void {
  const count = ctx.countRequests(filter);
  if (typeof expected === 'number') {
    if (count !== expected) {
      throw new Error(`Model call count mismatch: got ${count}, expected ${expected}`);
    }
  } else {
    if (expected.min !== undefined && count < expected.min) {
      throw new Error(`Model call count too low: got ${count}, expected min ${expected.min}`);
    }
    if (expected.max !== undefined && count > expected.max) {
      throw new Error(`Model call count too high: got ${count}, expected max ${expected.max}`);
    }
  }
}

export function assertNoErrors(ctx: LiveTestContext): void {
  const failed = ctx.getModelRequests({ status: 'failed' });
  if (failed.length > 0) {
    const details = failed.map((r) => `${r.agent}/${r.purpose}: ${r.error}`).join('; ');
    throw new Error(`Found ${failed.length} failed model request(s): ${details}`);
  }
}

export function assertNoLogErrors(ctx: LiveTestContext, opts?: { ignoreModules?: string[] }): void {
  let errors = ctx.getLogErrors();
  if (opts?.ignoreModules) {
    errors = errors.filter(e => !opts.ignoreModules!.includes(e.module));
  }
  if (errors.length > 0) {
    const details = errors.map(e => `[${e.module}] ${e.msg}`).join('\n  ');
    throw new Error(`Found ${errors.length} error log(s):\n  ${details}`);
  }
}

export function assertEventOccurred(ctx: LiveTestContext, event: string): void {
  const events = ctx.getEvents({ event });
  if (events.length === 0) {
    throw new Error(`Expected event '${event}' but it was never emitted`);
  }
}

export function assertStreamingOrder(result: StreamingResult): void {
  let seenDelta = false;
  let seenResult = false;
  for (const chunk of result.chunks) {
    if (seenResult) {
      throw new Error(`Received chunk type '${chunk.type}' after result`);
    }
    if (chunk.type === 'text_delta') {
      seenDelta = true;
    }
    if (chunk.type === 'result') {
      seenResult = true;
    }
  }
  if (!seenResult) {
    throw new Error('Stream did not end with result event');
  }
}

export function assertTimeToFirstChunk(result: StreamingResult, maxMs: number): void {
  if (result.firstChunkMs > maxMs) {
    throw new Error(`TTFC ${result.firstChunkMs}ms > max ${maxMs}ms`);
  }
}

export function assertStreamHasProgress(result: StreamingResult, status?: string): void {
  if (status) {
    const match = result.progressEvents.some(p => p.status === status);
    if (!match) {
      throw new Error(`Expected progress event with status '${status}', got: ${result.progressEvents.map(p => p.status).join(', ') || 'none'}`);
    }
  } else if (result.progressEvents.length === 0) {
    throw new Error('Expected at least one progress event, got none');
  }
}

// --- Span Assertions ---

export function assertSpanExists(ctx: LiveTestContext, name: string): void {
  const spans = ctx.getSpansByName(name);
  if (spans.length === 0) {
    throw new Error(`Expected span '${name}' but none found`);
  }
}

export function assertSpanAttribute(
  ctx: LiveTestContext,
  name: string,
  key: string,
  value: string | number | boolean,
): void {
  const spans = ctx.getSpansByName(name);
  const match = spans.some(s => s.attributes[key] === value);
  if (!match) {
    const found = spans.map(s => s.attributes[key]).filter(v => v !== undefined);
    throw new Error(
      `No span '${name}' with ${key}=${JSON.stringify(value)}. Found values: ${found.map(v => JSON.stringify(v)).join(', ') || 'none'}`,
    );
  }
}

export function assertSpanStatus(ctx: LiveTestContext, name: string, status: 'ok' | 'error'): void {
  const spans = ctx.getSpansByName(name);
  if (spans.length === 0) {
    throw new Error(`Expected span '${name}' but none found`);
  }
  const mismatched = spans.filter(s => s.status !== status);
  if (mismatched.length > 0) {
    throw new Error(
      `${mismatched.length} span(s) '${name}' have wrong status. Expected '${status}', got: ${mismatched.map(s => s.status).join(', ')}`,
    );
  }
}

export function assertNoErrorSpans(ctx: LiveTestContext): void {
  const errorSpans = ctx.getSpans().filter(s => s.status === 'error');
  if (errorSpans.length > 0) {
    const details = errorSpans.map(s => `${s.name}: ${s.error ?? 'no message'}`).join('; ');
    throw new Error(`Found ${errorSpans.length} error span(s): ${details}`);
  }
}

// --- Metrics Assertions ---

export function assertCounterValue(
  ctx: LiveTestContext,
  metric: string,
  expected: number | { min?: number; max?: number },
  labels?: Record<string, string>,
): void {
  const snapshot = ctx.getMetricsSnapshot();
  const entries = snapshot.counters[metric];
  if (!entries) {
    if (typeof expected === 'number' && expected === 0) return;
    if (typeof expected !== 'number' && (expected.min === undefined || expected.min === 0)) return;
    throw new Error(`Metric '${metric}' not found in snapshot`);
  }

  let value = 0;
  if (labels) {
    const entry = entries.find(e =>
      Object.entries(labels).every(([k, v]) => e.labels[k] === v),
    );
    value = entry?.value ?? 0;
  } else {
    value = entries.reduce((sum, e) => sum + e.value, 0);
  }

  if (typeof expected === 'number') {
    if (value !== expected) {
      throw new Error(`Counter '${metric}': got ${value}, expected ${expected}`);
    }
  } else {
    if (expected.min !== undefined && value < expected.min) {
      throw new Error(`Counter '${metric}': got ${value}, expected min ${expected.min}`);
    }
    if (expected.max !== undefined && value > expected.max) {
      throw new Error(`Counter '${metric}': got ${value}, expected max ${expected.max}`);
    }
  }
}

export function assertHistogramP95(
  ctx: LiveTestContext,
  metric: string,
  maxMs: number,
  labels?: Record<string, string>,
): void {
  const snapshot = ctx.getMetricsSnapshot();
  const entries = snapshot.histograms[metric];
  if (!entries || entries.length === 0) return;

  const matching = labels
    ? entries.filter(e => Object.entries(labels).every(([k, v]) => e.labels[k] === v))
    : entries;

  for (const entry of matching) {
    if (entry.p95 > maxMs) {
      const labelStr = Object.entries(entry.labels).map(([k, v]) => `${k}=${v}`).join(',');
      throw new Error(`Histogram '${metric}' [${labelStr}]: P95=${entry.p95}ms > max ${maxMs}ms`);
    }
  }
}

// --- Task Lifecycle Assertions ---

export function assertTaskCompleted(ctx: LiveTestContext, filter?: TaskFilter): void {
  const tasks = ctx.getAgentTasks(filter);
  if (tasks.length === 0) {
    throw new Error('No tasks found matching filter');
  }
  const incomplete = tasks.filter(t => t.status !== 'completed');
  if (incomplete.length > 0) {
    const details = incomplete.map(t => `${t.id}(${t.status}@${t.targetAgent})`).join(', ');
    throw new Error(`${incomplete.length} task(s) not completed: ${details}`);
  }
}

export function assertNoFailedTasks(ctx: LiveTestContext, filter?: TaskFilter): void {
  const tasks = ctx.getAgentTasks(filter);
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'timeout');
  if (failed.length > 0) {
    const details = failed.map(t => `${t.id}(${t.status}@${t.targetAgent}): ${t.error ?? 'unknown'}`).join('; ');
    throw new Error(`Found ${failed.length} failed/timeout task(s): ${details}`);
  }
}

export function assertTaskDuration(ctx: LiveTestContext, maxMs: number, filter?: TaskFilter): void {
  const tasks = ctx.getAgentTasks(filter);
  for (const t of tasks) {
    if (t.durationMs !== null && t.durationMs > maxMs) {
      throw new Error(
        `Task ${t.id} (${t.targetAgent}/${t.taskType}) took ${t.durationMs}ms > max ${maxMs}ms`,
      );
    }
  }
}

// --- Tool Call Assertions ---

export function assertToolWasCalled(ctx: LiveTestContext, toolName: string, filter?: ToolCallFilter): void {
  const calls = ctx.getToolCalls({ ...filter, toolName });
  if (calls.length === 0) {
    throw new Error(`Expected tool '${toolName}' to be called, but it was not`);
  }
}

export function assertToolSucceeded(ctx: LiveTestContext, toolName: string, filter?: ToolCallFilter): void {
  const calls = ctx.getToolCalls({ ...filter, toolName });
  if (calls.length === 0) {
    throw new Error(`Expected tool '${toolName}' to be called, but it was not`);
  }
  const failed = calls.filter(c => c.isError || c.finishedAt === null);
  if (failed.length > 0) {
    const details = failed.map(c => `${c.id}: isError=${c.isError}, finished=${c.finishedAt != null}`).join('; ');
    throw new Error(`${failed.length} call(s) to '${toolName}' did not succeed: ${details}`);
  }
}

export function assertNoToolErrors(ctx: LiveTestContext, filter?: ToolCallFilter): void {
  const errors = ctx.getToolCalls({ ...filter, isError: true });
  if (errors.length > 0) {
    const details = errors.map(c => `${c.toolName}(${c.agent}): ${c.result?.slice(0, 80) ?? 'unknown'}`).join('; ');
    throw new Error(`Found ${errors.length} tool error(s): ${details}`);
  }
}

// --- Approval Assertions ---

export function assertApprovalGranted(ctx: LiveTestContext, kind: string, filter?: ApprovalFilter): void {
  const approvals = ctx.getApprovalRequests({ ...filter, kind, status: 'approved' });
  if (approvals.length === 0) {
    const all = ctx.getApprovalRequests({ ...filter, kind });
    const statuses = all.map(a => a.status).join(', ') || 'none found';
    throw new Error(`Expected approved approval for kind '${kind}', got: ${statuses}`);
  }
}
