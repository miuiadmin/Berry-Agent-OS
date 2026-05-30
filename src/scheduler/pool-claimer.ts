import type Database from 'better-sqlite3';
import type { JobQueueRow } from './contracts.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('pool-claimer');

const POOL_SENTINEL = '__pool__';

export class PoolClaimer {
  constructor(private readonly db: Database.Database) {}

  claimNext(agentId: string, jobTypes?: string[]): JobQueueRow | null {
    const now = Date.now();
    let query: string;
    let params: unknown[];

    if (jobTypes && jobTypes.length > 0) {
      const placeholders = jobTypes.map(() => '?').join(',');
      query = `
        UPDATE job_queue
        SET agent_id = ?, status = 'claimed', claimed_at = ?
        WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending' AND agent_id = '${POOL_SENTINEL}'
            AND job_type IN (${placeholders})
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `;
      params = [agentId, now, ...jobTypes];
    } else {
      query = `
        UPDATE job_queue
        SET agent_id = ?, status = 'claimed', claimed_at = ?
        WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending' AND agent_id = '${POOL_SENTINEL}'
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `;
      params = [agentId, now];
    }

    const row = this.db.prepare(query).get(...params) as JobQueueRow | undefined;
    if (row) {
      logger.debug({ id: row.id, agent: agentId }, 'Pool job claimed');
    }
    return row ?? null;
  }

  releaseUnclaimed(jobId: string): void {
    this.db.prepare(`
      UPDATE job_queue SET agent_id = '${POOL_SENTINEL}', status = 'pending', claimed_at = NULL
      WHERE id = ? AND status = 'claimed'
    `).run(jobId);
  }

  getPoolDepth(jobTypes?: string[]): number {
    if (jobTypes && jobTypes.length > 0) {
      const placeholders = jobTypes.map(() => '?').join(',');
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM job_queue WHERE status = 'pending' AND agent_id = '${POOL_SENTINEL}' AND job_type IN (${placeholders})`
      ).get(...jobTypes) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM job_queue WHERE status = 'pending' AND agent_id = '${POOL_SENTINEL}'`
    ).get() as { cnt: number };
    return row.cnt;
  }
}
