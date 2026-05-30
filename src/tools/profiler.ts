import type { Database } from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('tool-profiler');

export interface ToolProfile {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
}

export class ToolProfiler {
  constructor(private db: Database) {}

  getProfile(toolName: string, windowMs = 3600000): ToolProfile | null {
    const cutoff = Date.now() - windowMs;

    const rows = this.db.prepare(`
      SELECT duration_ms, status
      FROM tool_calls
      WHERE tool_name = ? AND created_at >= ?
      ORDER BY duration_ms ASC
    `).all(toolName, cutoff) as Array<{ duration_ms: number; status: string }>;

    if (rows.length === 0) return null;

    const durations = rows.map(r => r.duration_ms);
    const errors = rows.filter(r => r.status === 'error').length;

    return {
      toolName,
      callCount: rows.length,
      errorCount: errors,
      errorRate: errors / rows.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
    };
  }

  getSlowTools(thresholdMs: number, windowMs = 3600000): ToolProfile[] {
    const cutoff = Date.now() - windowMs;

    const tools = this.db.prepare(`
      SELECT DISTINCT tool_name FROM tool_calls WHERE created_at >= ?
    `).all(cutoff) as Array<{ tool_name: string }>;

    const slow: ToolProfile[] = [];
    for (const { tool_name } of tools) {
      const profile = this.getProfile(tool_name, windowMs);
      if (profile && profile.p95Ms > thresholdMs) {
        slow.push(profile);
      }
    }

    return slow.sort((a, b) => b.p95Ms - a.p95Ms);
  }

  getErrorProne(thresholdRate: number, windowMs = 3600000): ToolProfile[] {
    const cutoff = Date.now() - windowMs;

    const tools = this.db.prepare(`
      SELECT DISTINCT tool_name FROM tool_calls WHERE created_at >= ?
    `).all(cutoff) as Array<{ tool_name: string }>;

    const errorProne: ToolProfile[] = [];
    for (const { tool_name } of tools) {
      const profile = this.getProfile(tool_name, windowMs);
      if (profile && profile.errorRate > thresholdRate && profile.callCount >= 3) {
        errorProne.push(profile);
      }
    }

    return errorProne.sort((a, b) => b.errorRate - a.errorRate);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
