import { metrics } from './metrics.js';

export const METRIC_CATALOG = {
  // Tools
  tool_calls_total: { labels: ['tool', 'agent', 'status'] },
  tool_duration_ms: { labels: ['tool', 'agent'] },

  // Memory
  memory_search_total: { labels: ['source'] },
  memory_search_duration_ms: { labels: ['source'] },
  memory_search_results: { labels: ['source'] },

  // Safety / Approvals
  approval_requests_total: { labels: ['kind', 'risk_level'] },
  approval_decisions_total: { labels: ['kind', 'decision', 'source'] },

  // MCP
  mcp_tool_calls_total: { labels: ['server', 'tool', 'status'] },
  mcp_reconnections_total: { labels: ['server'] },

  // Cron
  cron_executions_total: { labels: ['status'] },
  cron_duration_ms: { labels: ['task_id'] },

  // Task lifecycle
  task_lifecycle_total: { labels: ['task_type', 'status'] },
  task_queue_wait_ms: { labels: ['task_type', 'agent'] },
  task_execution_ms: { labels: ['task_type', 'agent'] },

  // Agent manager
  agent_crashes_total: { labels: ['agent'] },
  agent_restarts_total: { labels: ['agent'] },
  agent_circuit_breaks_total: { labels: ['agent'] },
} as const;

export type MetricName = keyof typeof METRIC_CATALOG;

export function incCounter(name: MetricName, labels: Record<string, string> = {}): void {
  metrics.counter(name).inc(labels);
}

export function observeDuration(name: MetricName, value: number, labels: Record<string, string> = {}): void {
  metrics.histogram(name).observe(value, labels);
}

export function timed<T>(name: MetricName, labels: Record<string, string>, fn: () => T): T {
  const t0 = Date.now();
  const result = fn();
  if (result instanceof Promise) {
    return result.then((v) => {
      metrics.histogram(name).observe(Date.now() - t0, labels);
      return v;
    }) as T;
  }
  metrics.histogram(name).observe(Date.now() - t0, labels);
  return result;
}
