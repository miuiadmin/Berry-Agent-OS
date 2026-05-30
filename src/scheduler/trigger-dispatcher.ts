import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { CronJobRow, TriggerSource, DispatchResult, ITriggerDispatcher } from './contracts.js';
import { JobQueue } from './job-queue.js';
import { ConcurrencyGuard } from './concurrency-guard.js';
import { AdmissionGate } from './admission-gate.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { getCurrentTrace } from '../observability/trace-context.js';

const logger = getLogger('trigger-dispatcher');

export class TriggerDispatcher implements ITriggerDispatcher {
  constructor(
    private readonly db: Database.Database,
    private readonly jobQueue: JobQueue,
    private readonly concurrencyGuard: ConcurrencyGuard,
    private readonly admissionGate: AdmissionGate,
    private readonly eventBus: EventBus,
  ) {}

  trigger(jobId: string, source: TriggerSource, payload?: unknown): DispatchResult {
    const job = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(jobId) as CronJobRow | undefined;
    if (!job) {
      return { ok: false, reason: `Job not found: ${jobId}`, action: 'skipped' };
    }

    if (!job.enabled) {
      return { ok: false, reason: 'Job is disabled', action: 'skipped' };
    }

    const admission = this.admissionGate.check(job);
    if (!admission.admitted) {
      this.recordExecution(job, source, 'skipped', admission.reason);
      logger.debug({ jobId, reason: admission.reason }, 'Admission gate rejected');
      return { ok: false, reason: admission.reason, action: 'skipped' };
    }

    const concurrency = this.concurrencyGuard.check(job);

    if (concurrency.action === 'forbid') {
      logger.debug({ jobId }, 'Concurrency policy: forbid');
      return { ok: false, reason: concurrency.reason, action: 'forbidden' };
    }

    if (concurrency.action === 'replace') {
      this.concurrencyGuard.markExecutionDone(concurrency.killExecutionId, 'failed', 'Replaced by new trigger');
    }

    const executionId = this.recordExecution(job, source, 'running');
    const traceId = getCurrentTrace()?.traceId ?? null;

    const queueItemId = this.jobQueue.enqueue({
      workspaceId: job.workspace_id,
      agentId: job.session_mode === 'pool' ? '__pool__' : job.agent_id,
      jobType: 'scheduled_job',
      sourceId: executionId,
      payload: {
        jobId: job.id,
        executionId,
        prompt: job.prompt,
        triggerSource: source.type,
        ...(payload ? { triggerPayload: payload } : {}),
      },
      priority: 0,
      traceId: traceId ?? undefined,
      maxRetries: job.max_retries,
      timeoutMs: undefined,
    });

    this.updateLastTriggered(job.id);

    this.eventBus.emit('scheduler.job_enqueued', {
      jobId: job.id,
      queueItemId,
      triggerSource: source.type,
    });

    logger.debug({ jobId, executionId, queueItemId, source: source.type }, 'Job triggered');
    return { ok: true, queueItemId, executionId };
  }

  private recordExecution(job: CronJobRow, source: TriggerSource, status: string, error?: string): string {
    const id = genId('exec');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO cron_executions (id, job_id, workspace_id, trigger_source, status, started_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, job.id, job.workspace_id, source.type, status, now, error ?? null);

    return id;
  }

  private updateLastTriggered(jobId: string): void {
    this.db.prepare('UPDATE cron_jobs SET last_triggered_at = ? WHERE id = ?').run(Date.now(), jobId);
  }
}
