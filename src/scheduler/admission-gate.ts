import type Database from 'better-sqlite3';
import type { CronJobRow, AdmissionResult } from './contracts.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('admission-gate');

export class AdmissionGate {
  constructor(private readonly db: Database.Database) {}

  check(job: CronJobRow): AdmissionResult {
    if (!job.admission_gate) {
      return { admitted: true };
    }

    if (!job.prompt || job.prompt.trim().length === 0) {
      return { admitted: false, reason: 'Job prompt is empty' };
    }

    if (!job.agent_id || job.agent_id.trim().length === 0) {
      return { admitted: false, reason: 'No agent assigned' };
    }

    const agent = this.db.prepare(
      "SELECT status FROM agents_meta WHERE name = ? OR id = ?"
    ).get(job.agent_id, job.agent_id) as { status: string } | undefined;

    if (!agent) {
      return { admitted: false, reason: `Agent not found: ${job.agent_id}` };
    }

    if (agent.status !== 'enabled') {
      return { admitted: false, reason: `Agent not enabled (status: ${agent.status})` };
    }

    if (job.workspace_id) {
      const ws = this.db.prepare(
        'SELECT id FROM workspaces WHERE id = ?'
      ).get(job.workspace_id) as { id: string } | undefined;

      if (!ws) {
        return { admitted: false, reason: `Workspace not found: ${job.workspace_id}` };
      }
    }

    return { admitted: true };
  }
}
