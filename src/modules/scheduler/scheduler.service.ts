import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { CronScheduler, parseCronExpression, getNextTrigger } from '../../lib/cron.js';
import type { JobQueueService } from '../../lib/queue.js';
import { SchedulerRepository } from './scheduler.repository.js';
import type { CronJob, Reminder } from './scheduler.repository.js';

export interface CreateJobInput {
  workspaceId: string;
  agentId: string;
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMinutes?: number;
  scheduleType: 'cron' | 'interval' | 'webhook' | 'event';
  prompt: string;
  concurrencyPolicy?: 'queue' | 'replace' | 'forbid';
  executionMode?: 'create_task' | 'run_only';
  sessionMode?: 'new' | 'reuse';
  maxRetries?: number;
  enabled?: boolean;
}

export interface CreateReminderInput {
  agentId: string;
  workspaceId: string;
  name?: string;
  prompt: string;
  triggerAt: Date;
  recurringCron?: string;
}

export class SchedulerService {
  private cronScheduler = new CronScheduler();

  constructor(
    private repo: SchedulerRepository,
    private queue: JobQueueService,
    private events: AppEvents,
  ) {}

  createJob(input: CreateJobInput): CronJob {
    const id = genId();
    const now = new Date();

    let nextTriggerAt: Date | null = null;
    if (input.cronExpression) {
      const fields = parseCronExpression(input.cronExpression);
      nextTriggerAt = getNextTrigger(fields, now);
    }

    const job = {
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      name: input.name,
      description: input.description ?? null,
      cronExpression: input.cronExpression ?? null,
      intervalMinutes: input.intervalMinutes ?? null,
      scheduleType: input.scheduleType,
      webhookSecret: null,
      webhookToken: null,
      eventFilter: null,
      concurrencyPolicy: input.concurrencyPolicy ?? 'queue',
      executionMode: input.executionMode ?? 'run_only',
      admissionGate: 1,
      prompt: input.prompt,
      chainConfig: null,
      fanOutConfig: null,
      sessionMode: input.sessionMode ?? 'new',
      enabled: input.enabled !== false ? 1 : 0,
      maxRetries: input.maxRetries ?? 3,
      retryDelayMs: 5000,
      lastTriggeredAt: null,
      nextTriggerAt,
      createdAt: now,
    };

    this.repo.insertJob(job);

    if (input.enabled !== false && input.cronExpression) {
      this.scheduleCronJob(id, input.cronExpression, input.workspaceId, input.agentId, input.prompt);
    }

    this.events.emit('scheduler.job.created', { jobId: id, workspaceId: input.workspaceId });
    return job as CronJob;
  }

  private scheduleCronJob(jobId: string, expression: string, workspaceId: string, agentId: string, prompt: string): void {
    this.cronScheduler.schedule(jobId, expression, () => {
      this.triggerJob(jobId);
    });
  }

  triggerJob(jobId: string): void {
    const job = this.repo.findJobById(jobId);
    if (!job || !job.enabled) return;

    const executionId = genId();
    this.repo.insertExecution({
      id: executionId,
      jobId,
      workspaceId: job.workspaceId,
      roundId: null,
      status: 'running',
      totalAgents: null,
      completedCount: 0,
      failedCount: 0,
      startedAt: new Date(),
      completedAt: null,
      summary: null,
    });

    this.queue.enqueue({
      workspaceId: job.workspaceId,
      agentId: job.agentId,
      jobType: 'cron',
      sourceId: jobId,
      payload: { prompt: job.prompt, cronExecutionId: executionId },
      maxRetries: job.maxRetries,
    });

    this.repo.updateJob(jobId, { lastTriggeredAt: new Date() });
    this.events.emit('scheduler.job.triggered', { jobId, executionId });
  }

  enableJob(jobId: string): void {
    const job = this.repo.findJobById(jobId);
    if (!job) return;
    this.repo.updateJob(jobId, { enabled: 1 });
    if (job.cronExpression) {
      this.scheduleCronJob(jobId, job.cronExpression, job.workspaceId, job.agentId, job.prompt);
    }
  }

  disableJob(jobId: string): void {
    this.repo.updateJob(jobId, { enabled: 0 });
    this.cronScheduler.unschedule(jobId);
  }

  deleteJob(jobId: string): void {
    this.cronScheduler.unschedule(jobId);
    this.repo.deleteJob(jobId);
  }

  listJobs(workspaceId: string): CronJob[] {
    return this.repo.findJobsByWorkspace(workspaceId);
  }

  // Reminders
  createReminder(input: CreateReminderInput): Reminder {
    const id = genId();
    const reminder = {
      id,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      name: input.name ?? null,
      prompt: input.prompt,
      triggerAt: input.triggerAt,
      recurringCron: input.recurringCron ?? null,
      enabled: 1,
      lastFiredAt: null,
      createdAt: new Date(),
    };
    this.repo.insertReminder(reminder);
    return reminder as Reminder;
  }

  listReminders(agentId: string): Reminder[] {
    return this.repo.findRemindersByAgent(agentId);
  }

  shutdown(): void {
    this.cronScheduler.clear();
  }
}
