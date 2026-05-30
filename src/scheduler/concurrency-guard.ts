import type Database from 'better-sqlite3';
import type { CronJobRow, ConcurrencyDecision } from './contracts.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('concurrency-guard');

export class ConcurrencyGuard {
  constructor(private readonly db: Database.Database) {}

  check(job: CronJobRow): ConcurrencyDecision {
    const running = this.db.prepare(
      `SELECT id FROM cron_executions WHERE job_id = ? AND status = 'running'`
    ).all(job.id) as { id: string }[];

    if (running.length === 0) return { action: 'proceed' };

    switch (job.concurrency_policy) {
      case 'queue':
        logger.debug({ jobId: job.id, running: running.length }, 'Concurrency: queuing');
        return { action: 'queue' };
      case 'replace':
        logger.debug({ jobId: job.id, kill: running[0].id }, 'Concurrency: replacing');
        return { action: 'replace', killExecutionId: running[0].id };
      case 'forbid':
        logger.debug({ jobId: job.id }, 'Concurrency: forbidden');
        return { action: 'forbid', reason: '已有执行中任务，并发策略为 forbid' };
    }
  }

  markExecutionDone(executionId: string, status: 'completed' | 'failed' | 'timeout', error?: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE cron_executions SET status = ?, completed_at = ?, error = ? WHERE id = ? AND status = 'running'
    `).run(status, now, error ?? null, executionId);
  }

  getRunningCount(jobId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM cron_executions WHERE job_id = ? AND status = 'running'`
    ).get(jobId) as { cnt: number };
    return row.cnt;
  }
}
