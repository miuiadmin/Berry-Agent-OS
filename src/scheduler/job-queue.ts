import type Database from 'better-sqlite3';
import type { EnqueueInput, JobQueueRow, JobStatus, QueueStatus, IJobQueue } from './contracts.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('job-queue');

export class JobQueue implements IJobQueue {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueInput): string {
    const id = genId('jq');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO job_queue (id, workspace_id, agent_id, job_type, source_id, payload, status, priority, trace_id, max_retries, timeout_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.workspaceId,
      input.agentId,
      input.jobType,
      input.sourceId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.traceId ?? null,
      input.maxRetries ?? 3,
      input.timeoutMs ?? 300_000,
      now,
    );

    metrics.counter('job_queue_enqueued_total').inc({ job_type: input.jobType });
    logger.debug({ id, jobType: input.jobType, agent: input.agentId }, 'Job enqueued');
    return id;
  }

  claim(agentId: string, jobTypes?: string[]): JobQueueRow | null {
    const now = Date.now();
    let query: string;
    let params: unknown[];

    if (jobTypes && jobTypes.length > 0) {
      const placeholders = jobTypes.map(() => '?').join(',');
      query = `
        UPDATE job_queue SET status = 'claimed', claimed_at = ?
        WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending'
            AND (agent_id = ? OR agent_id = '__pool__')
            AND job_type IN (${placeholders})
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `;
      params = [now, agentId, ...jobTypes];
    } else {
      query = `
        UPDATE job_queue SET status = 'claimed', claimed_at = ?
        WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending'
            AND (agent_id = ? OR agent_id = '__pool__')
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `;
      params = [now, agentId];
    }

    const row = this.db.prepare(query).get(...params) as JobQueueRow | undefined;
    if (row) {
      metrics.counter('job_queue_claimed_total').inc({ agent: agentId });
      logger.debug({ id: row.id, agent: agentId }, 'Job claimed');
    }
    return row ?? null;
  }

  markRunning(jobId: string): void {
    this.db.prepare(`
      UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'claimed'
    `).run(Date.now(), jobId);
  }

  complete(jobId: string, output?: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE job_queue SET status = 'completed', output = ?, completed_at = ? WHERE id = ? AND status IN ('running','claimed')
    `).run(output ?? null, now, jobId);
    metrics.counter('job_queue_completed_total').inc();
    logger.debug({ id: jobId }, 'Job completed');
  }

  fail(jobId: string, error: string): boolean {
    const now = Date.now();
    const row = this.db.prepare('SELECT retry_count, max_retries FROM job_queue WHERE id = ?').get(jobId) as
      | { retry_count: number; max_retries: number }
      | undefined;

    if (!row) return false;

    if (row.retry_count < row.max_retries) {
      this.db.prepare(`
        UPDATE job_queue SET status = 'pending', error = ?, retry_count = retry_count + 1, claimed_at = NULL, started_at = NULL
        WHERE id = ?
      `).run(error, jobId);
      metrics.counter('job_queue_retried_total').inc();
      logger.debug({ id: jobId, retry: row.retry_count + 1 }, 'Job re-enqueued for retry');
      return true;
    }

    this.db.prepare(`
      UPDATE job_queue SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
    `).run(error, now, jobId);
    metrics.counter('job_queue_failed_total').inc();
    logger.warn({ id: jobId, error }, 'Job failed permanently');
    return false;
  }

  retry(jobId: string): boolean {
    const row = this.db.prepare('SELECT status, retry_count, max_retries FROM job_queue WHERE id = ?').get(jobId) as
      | { status: string; retry_count: number; max_retries: number }
      | undefined;

    if (!row || row.status !== 'failed') return false;

    this.db.prepare(`
      UPDATE job_queue SET status = 'pending', error = NULL, retry_count = 0, claimed_at = NULL, started_at = NULL, completed_at = NULL
      WHERE id = ?
    `).run(jobId);
    return true;
  }

  getDepth(agentId?: string): number {
    if (agentId) {
      const row = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM job_queue WHERE agent_id = ? AND status IN ('pending','claimed','running')"
      ).get(agentId) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM job_queue WHERE status IN ('pending','claimed','running')"
    ).get() as { cnt: number };
    return row.cnt;
  }

  getStatus(workspaceId?: string): QueueStatus {
    const whereClause = workspaceId ? 'WHERE workspace_id = ?' : '';
    const params = workspaceId ? [workspaceId] : [];

    const counts = this.db.prepare(`
      SELECT status, COUNT(*) as cnt FROM job_queue ${whereClause} AND status IN ('pending','claimed','running')
      GROUP BY status
    `.replace('AND', whereClause ? 'AND' : 'WHERE')).all(...params) as { status: string; cnt: number }[];

    const result: QueueStatus = { pending: 0, claimed: 0, running: 0, byAgent: {} };
    for (const row of counts) {
      if (row.status === 'pending') result.pending = row.cnt;
      else if (row.status === 'claimed') result.claimed = row.cnt;
      else if (row.status === 'running') result.running = row.cnt;
    }

    const agentCounts = this.db.prepare(`
      SELECT agent_id, status, COUNT(*) as cnt FROM job_queue
      ${workspaceId ? 'WHERE workspace_id = ?' : ''}
      ${workspaceId ? 'AND' : 'WHERE'} status IN ('pending','running')
      GROUP BY agent_id, status
    `).all(...params) as { agent_id: string; status: string; cnt: number }[];

    for (const row of agentCounts) {
      if (!result.byAgent[row.agent_id]) {
        result.byAgent[row.agent_id] = { pending: 0, running: 0 };
      }
      if (row.status === 'pending') result.byAgent[row.agent_id].pending = row.cnt;
      else if (row.status === 'running') result.byAgent[row.agent_id].running = row.cnt;
    }

    return result;
  }

  cancel(jobId: string): boolean {
    const result = this.db.prepare(`
      UPDATE job_queue SET status = 'skipped', completed_at = ? WHERE id = ? AND status IN ('pending','claimed')
    `).run(Date.now(), jobId);
    return result.changes > 0;
  }

  listBySource(sourceId: string, limit = 50): JobQueueRow[] {
    return this.db.prepare(
      'SELECT * FROM job_queue WHERE source_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(sourceId, limit) as JobQueueRow[];
  }

  listPending(limit = 50): JobQueueRow[] {
    return this.db.prepare(
      "SELECT * FROM job_queue WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT ?"
    ).all(limit) as JobQueueRow[];
  }

  purgeCompleted(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare(
      "DELETE FROM job_queue WHERE status IN ('completed','failed','skipped','timeout') AND completed_at < ?"
    ).run(cutoff);
    return result.changes;
  }
}
