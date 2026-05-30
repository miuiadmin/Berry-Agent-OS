import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auto-pause');

export interface AutoPauseConfig {
  enabled: boolean;
  threshold: number;
  windowDays: number;
  minExecutions: number;
}

const DEFAULT_CONFIG: AutoPauseConfig = {
  enabled: true,
  threshold: 0.9,
  windowDays: 7,
  minExecutions: 50,
};

export interface AutoPauseDecision {
  shouldPause: boolean;
  failureRate: number;
  totalExecutions: number;
  reason?: string;
}

export class AutoPauseMonitor {
  private readonly config: AutoPauseConfig;

  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    config: Partial<AutoPauseConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(jobId: string): AutoPauseDecision {
    if (!this.config.enabled) {
      return { shouldPause: false, failureRate: 0, totalExecutions: 0 };
    }

    const windowStart = Date.now() - this.config.windowDays * 24 * 60 * 60 * 1000;

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as fails
      FROM cron_executions
      WHERE job_id = ? AND started_at > ?
    `).get(jobId, windowStart) as { total: number; fails: number };

    const total = row.total;
    const fails = row.fails ?? 0;

    if (total < this.config.minExecutions) {
      return { shouldPause: false, failureRate: total > 0 ? fails / total : 0, totalExecutions: total };
    }

    const failureRate = fails / total;

    if (failureRate >= this.config.threshold) {
      return {
        shouldPause: true,
        failureRate,
        totalExecutions: total,
        reason: `Failure rate ${(failureRate * 100).toFixed(1)}% over ${total} executions in ${this.config.windowDays} days`,
      };
    }

    return { shouldPause: false, failureRate, totalExecutions: total };
  }

  checkAndPause(jobId: string): boolean {
    const decision = this.evaluate(jobId);
    if (!decision.shouldPause) return false;

    this.db.prepare(
      "UPDATE cron_jobs SET enabled = 0, pause_reason = ? WHERE id = ? AND enabled = 1"
    ).run(decision.reason, jobId);

    this.eventBus.emit('scheduler.auto_paused', {
      jobId,
      failureRate: decision.failureRate,
      totalExecutions: decision.totalExecutions,
    });

    logger.warn({ jobId, failureRate: decision.failureRate, total: decision.totalExecutions }, 'Job auto-paused');
    return true;
  }

  runFullScan(): string[] {
    const jobs = this.db.prepare(
      "SELECT id FROM cron_jobs WHERE enabled = 1"
    ).all() as { id: string }[];

    const paused: string[] = [];
    for (const job of jobs) {
      if (this.checkAndPause(job.id)) {
        paused.push(job.id);
      }
    }

    if (paused.length > 0) {
      logger.info({ count: paused.length }, 'Auto-pause scan completed');
    }

    return paused;
  }
}
