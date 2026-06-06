import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { LlmClient } from '../llm/index.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { TaskManager } from '../kernel/task-manager.js';
import { safeJsonParse } from '../utils/safe-json.js';
import type { ErrorClassifier } from '../kernel/error-classifier.js';
import type {
  CronJobRow, CronExecutionRow, JobQueueRow, CreateJobInput,
  DispatchResult, QueueStatus, ISchedulerService, SchedulerConfig,
} from './contracts.js';
import { DEFAULT_SCHEDULER_CONFIG } from './contracts.js';
import { JobQueue } from './job-queue.js';
import { ConcurrencyGuard } from './concurrency-guard.js';
import { AdmissionGate } from './admission-gate.js';
import { JobExecutor } from './job-executor.js';
import { TriggerDispatcher } from './trigger-dispatcher.js';
import { WebhookReceiver } from './webhook-receiver.js';
import { EventTrigger } from './event-trigger.js';
import { ChainExecutor } from './chain-executor.js';
import { PoolClaimer } from './pool-claimer.js';
import { ReminderService } from './reminder-service.js';
import { AutoPauseMonitor } from './auto-pause.js';
import { RetryPolicy } from './retry-policy.js';
import { computeNextRun } from '../cron/parser.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('scheduler-service');

export interface SchedulerServiceDeps {
  db: Database.Database;
  eventBus: EventBus;
  taskManager: TaskManager;
  llm: LlmClient;
  skillLoader: ISkillLoader;
  errorClassifier: ErrorClassifier;
}

export class SchedulerService implements ISchedulerService {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly config: SchedulerConfig;

  readonly jobQueue: JobQueue;
  readonly concurrencyGuard: ConcurrencyGuard;
  readonly admissionGate: AdmissionGate;
  readonly jobExecutor: JobExecutor;
  readonly dispatcher: TriggerDispatcher;
  readonly webhookReceiver: WebhookReceiver;
  readonly eventTrigger: EventTrigger;
  readonly chainExecutor: ChainExecutor;
  readonly poolClaimer: PoolClaimer;
  readonly reminderService: ReminderService;
  readonly autoPauseMonitor: AutoPauseMonitor;
  readonly retryPolicy: RetryPolicy;

  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private queueProcessing = false;
  private runningJobs = new Map<string, AbortController>();

  constructor(deps: SchedulerServiceDeps, config: Partial<SchedulerConfig> = {}) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

    this.jobQueue = new JobQueue(deps.db);
    this.concurrencyGuard = new ConcurrencyGuard(deps.db);
    this.admissionGate = new AdmissionGate(deps.db);
    this.jobExecutor = new JobExecutor({
      db: deps.db,
      llm: deps.llm,
      skillLoader: deps.skillLoader,
      eventBus: deps.eventBus,
      taskManager: deps.taskManager,
    }, {
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      scriptTimeoutMs: this.config.scriptTimeoutMs,
      maxOutputChars: this.config.maxOutputChars,
    });
    this.dispatcher = new TriggerDispatcher(deps.db, this.jobQueue, this.concurrencyGuard, this.admissionGate, deps.eventBus);
    this.webhookReceiver = new WebhookReceiver(deps.db, this.dispatcher);
    this.eventTrigger = new EventTrigger(deps.db, deps.eventBus, this.dispatcher);
    this.chainExecutor = new ChainExecutor(deps.db, deps.eventBus, this.dispatcher);
    this.poolClaimer = new PoolClaimer(deps.db);
    this.reminderService = new ReminderService(deps.db, deps.eventBus);
    this.autoPauseMonitor = new AutoPauseMonitor(deps.db, deps.eventBus, {
      enabled: this.config.autoPauseEnabled,
      threshold: this.config.autoPauseThreshold,
      windowDays: this.config.autoPauseWindowDays,
      minExecutions: this.config.autoPauseMinExecutions,
    });
    this.retryPolicy = new RetryPolicy(deps.errorClassifier);
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('Scheduler disabled by config');
      return;
    }

    this.cronTimer = setInterval(() => void this.cronTick(), this.config.cronTickIntervalMs);
    this.queueTimer = setInterval(() => void this.queueTick(), this.config.queuePollIntervalMs);
    this.eventTrigger.start();

    // 每小时清理已完成的 job_queue 记录（保留 7 天）
    const purgeTimer = setInterval(() => {
      this.jobQueue.purgeCompleted(7 * 24 * 60 * 60 * 1000);
    }, 60 * 60 * 1000);
    purgeTimer.unref();

    logger.info({
      cronInterval: this.config.cronTickIntervalMs,
      queueInterval: this.config.queuePollIntervalMs,
    }, 'Scheduler service started');

    // 启动时回收因进程崩溃遗留的 stale running 状态
    const staleRecovered = this.db.prepare(
      `UPDATE cron_executions SET status = 'failed', error = '服务重启: stale recovery' WHERE status = 'running'`,
    ).run();
    if (staleRecovered.changes > 0) {
      logger.info({ count: staleRecovered.changes }, 'scheduler:recovered stale cron executions');
    }
  }

  stop(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.eventTrigger.stop();

    for (const [, controller] of this.runningJobs) {
      controller.abort();
    }
    this.runningJobs.clear();

    logger.info('Scheduler service stopped');
  }

  // === CRUD ===

  createJob(input: CreateJobInput): string {
    const id = genId('cj');
    const now = Date.now();

    let nextTrigger: number | null = null;
    if (input.scheduleType === 'cron' && input.cronExpression) {
      nextTrigger = computeNextRun(input.cronExpression, now);
    }

    const webhookToken = input.scheduleType === 'webhook' ? genId('wht') : null;

    this.db.prepare(`
      INSERT INTO cron_jobs (
        id, workspace_id, agent_id, name, description, cron_expression, interval_minutes,
        schedule_type, webhook_secret, webhook_token, event_filter,
        concurrency_policy, execution_mode, admission_gate, prompt,
        chain_config, fan_out_config, session_mode, max_retries, retry_delay_ms,
        next_trigger_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.workspaceId, input.agentId, input.name, input.description ?? null,
      input.cronExpression ?? null, input.intervalMinutes ?? null,
      input.scheduleType, input.webhookSecret ?? null, webhookToken,
      input.eventFilter ? JSON.stringify(input.eventFilter) : null,
      input.concurrencyPolicy ?? 'queue', input.executionMode ?? 'run_only',
      input.admissionGate !== false ? 1 : 0, input.prompt,
      input.chainConfig ? JSON.stringify(input.chainConfig) : null,
      input.fanOutConfig ? JSON.stringify(input.fanOutConfig) : null,
      input.sessionMode ?? 'new', input.maxRetries ?? 3, input.retryDelayMs ?? 5000,
      nextTrigger, now,
    );

    if (input.scheduleType === 'event') {
      this.eventTrigger.refresh();
    }

    logger.debug({ id, name: input.name, type: input.scheduleType }, 'Job created');
    return id;
  }

  updateJob(jobId: string, updates: Partial<CreateJobInput>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.cronExpression !== undefined) { fields.push('cron_expression = ?'); values.push(updates.cronExpression); }
    if (updates.intervalMinutes !== undefined) { fields.push('interval_minutes = ?'); values.push(updates.intervalMinutes); }
    if (updates.concurrencyPolicy !== undefined) { fields.push('concurrency_policy = ?'); values.push(updates.concurrencyPolicy); }
    if (updates.executionMode !== undefined) { fields.push('execution_mode = ?'); values.push(updates.executionMode); }
    if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
    if (updates.maxRetries !== undefined) { fields.push('max_retries = ?'); values.push(updates.maxRetries); }
    if (updates.retryDelayMs !== undefined) { fields.push('retry_delay_ms = ?'); values.push(updates.retryDelayMs); }
    if (updates.sessionMode !== undefined) { fields.push('session_mode = ?'); values.push(updates.sessionMode); }
    if (updates.eventFilter !== undefined) { fields.push('event_filter = ?'); values.push(JSON.stringify(updates.eventFilter)); }
    if (updates.chainConfig !== undefined) { fields.push('chain_config = ?'); values.push(JSON.stringify(updates.chainConfig)); }
    if (updates.fanOutConfig !== undefined) { fields.push('fan_out_config = ?'); values.push(JSON.stringify(updates.fanOutConfig)); }
    if (updates.admissionGate !== undefined) { fields.push('admission_gate = ?'); values.push(updates.admissionGate ? 1 : 0); }

    if (fields.length === 0) return;

    values.push(jobId);
    this.db.prepare(`UPDATE cron_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    if (updates.eventFilter !== undefined) {
      this.eventTrigger.refresh();
    }
  }

  deleteJob(jobId: string): void {
    this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(jobId);
    this.eventTrigger.refresh();
  }

  getJob(jobId: string): CronJobRow | null {
    return (this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(jobId) as CronJobRow | undefined) ?? null;
  }

  listJobs(workspaceId?: string): CronJobRow[] {
    if (workspaceId) {
      return this.db.prepare('SELECT * FROM cron_jobs WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as CronJobRow[];
    }
    return this.db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as CronJobRow[];
  }

  pauseJob(jobId: string, reason: string): void {
    this.db.prepare('UPDATE cron_jobs SET enabled = 0, pause_reason = ? WHERE id = ?').run(reason, jobId);
  }

  resumeJob(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job) return;

    let nextTrigger: number | null = null;
    if (job.schedule_type === 'cron' && job.cron_expression) {
      nextTrigger = computeNextRun(job.cron_expression, Date.now());
    }

    this.db.prepare('UPDATE cron_jobs SET enabled = 1, pause_reason = NULL, next_trigger_at = ? WHERE id = ?').run(nextTrigger, jobId);
    if (job.schedule_type === 'event') this.eventTrigger.refresh();
  }

  triggerNow(jobId: string): DispatchResult {
    return this.dispatcher.trigger(jobId, { type: 'manual' });
  }

  getExecutionHistory(jobId: string, limit = 50): CronExecutionRow[] {
    return this.db.prepare(
      'SELECT * FROM cron_executions WHERE job_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(jobId, limit) as CronExecutionRow[];
  }

  getQueueStatus(workspaceId?: string): QueueStatus {
    return this.jobQueue.getStatus(workspaceId);
  }

  // === Tick Loops ===

  private async cronTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = Date.now();

      const dueJobs = this.db.prepare(
        "SELECT * FROM cron_jobs WHERE enabled = 1 AND schedule_type = 'cron' AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?"
      ).all(now) as CronJobRow[];

      for (const job of dueJobs) {
        this.dispatcher.trigger(job.id, { type: 'cron' });
        this.advanceNextRun(job, now);
      }

      this.reminderService.checkDue(now);
    } finally {
      this.ticking = false;
    }
  }

  private async queueTick(): Promise<void> {
    if (this.queueProcessing) return;
    this.queueProcessing = true;

    try {
      const pending = this.db.prepare(
        "SELECT * FROM job_queue WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 10"
      ).all() as JobQueueRow[];

      for (const item of pending) {
        if (this.runningJobs.has(item.id)) continue;
        this.processQueueItem(item);
      }
    } finally {
      this.queueProcessing = false;
    }
  }

  private processQueueItem(item: JobQueueRow): void {
    const payload = safeJsonParse<Record<string, unknown>>(item.payload || '{}', {});
    const jobId = payload.jobId as string | undefined;

    const job = jobId
      ? this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(jobId) as CronJobRow | undefined
      : undefined;

    if (!job) {
      this.jobQueue.complete(item.id, 'Job not found');
      return;
    }

    const controller = new AbortController();
    this.runningJobs.set(item.id, controller);
    this.jobQueue.markRunning(item.id);

    this.eventBus.emit('scheduler.job_claimed', { queueItemId: item.id, agentId: item.agent_id });

    this.jobExecutor.execute(item, job, controller.signal).then(result => {
      this.runningJobs.delete(item.id);
      const executionId = payload.executionId as string | undefined;

      if (result.ok) {
        this.jobQueue.complete(item.id, result.output);
        if (executionId) {
          this.concurrencyGuard.markExecutionDone(executionId, 'completed');
        }
        this.eventBus.emit('scheduler.job_completed', {
          queueItemId: item.id,
          jobId: job.id,
          durationMs: result.durationMs,
        });
        metrics.histogram('scheduler_job_duration_ms').observe(result.durationMs, { job_type: item.job_type });

        if (payload.chainRoundId) {
          this.chainExecutor.completeStep(
            payload.chainRoundId as string,
            payload.chainStepId as string,
            result.output,
          );
        }
      } else {
        const retried = this.jobQueue.fail(item.id, result.output);
        if (!retried) {
          if (executionId) {
            this.concurrencyGuard.markExecutionDone(executionId, 'failed', result.output);
          }
          this.autoPauseMonitor.checkAndPause(job.id);
        }
        this.eventBus.emit('scheduler.job_failed', {
          queueItemId: item.id,
          jobId: job.id,
          error: result.output,
          retryable: retried,
        });

        if (payload.chainRoundId && !retried) {
          this.chainExecutor.failStep(
            payload.chainRoundId as string,
            payload.chainStepId as string,
            result.output,
          );
        }
      }
    }).catch(err => {
      this.runningJobs.delete(item.id);
      const message = err instanceof Error ? err.message : String(err);
      this.jobQueue.fail(item.id, message);
      logger.error({ itemId: item.id, error: message }, 'Queue item processing error');
    });
  }

  private advanceNextRun(job: CronJobRow, now: number): void {
    if (!job.cron_expression) return;
    const next = computeNextRun(job.cron_expression, now);
    this.db.prepare('UPDATE cron_jobs SET next_trigger_at = ?, last_triggered_at = ? WHERE id = ?').run(next, now, job.id);
  }
}
