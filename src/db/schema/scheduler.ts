import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { agents } from './agents.js';

export const cronJobs = sqliteTable('cron_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  name: text('name').notNull(),
  description: text('description'),
  cronExpression: text('cron_expression'),
  intervalMinutes: integer('interval_minutes'),
  scheduleType: text('schedule_type').notNull(),
  webhookSecret: text('webhook_secret'),
  webhookToken: text('webhook_token'),
  eventFilter: text('event_filter', { mode: 'json' }),
  concurrencyPolicy: text('concurrency_policy').notNull().default('queue'),
  executionMode: text('execution_mode').notNull().default('run_only'),
  admissionGate: integer('admission_gate').notNull().default(1),
  prompt: text('prompt').notNull(),
  chainConfig: text('chain_config', { mode: 'json' }),
  fanOutConfig: text('fan_out_config', { mode: 'json' }),
  sessionMode: text('session_mode').notNull().default('new'),
  enabled: integer('enabled').notNull().default(1),
  maxRetries: integer('max_retries').notNull().default(3),
  retryDelayMs: integer('retry_delay_ms').notNull().default(5000),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
  nextTriggerAt: integer('next_trigger_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const cronExecutions = sqliteTable('cron_executions', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cronJobs.id),
  workspaceId: text('workspace_id').notNull(),
  roundId: text('round_id'),
  status: text('status').notNull(),
  totalAgents: integer('total_agents'),
  completedCount: integer('completed_count').default(0),
  failedCount: integer('failed_count').default(0),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  summary: text('summary'),
});

export const jobQueue = sqliteTable('job_queue', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  jobType: text('job_type').notNull(),
  sourceId: text('source_id'),
  payload: text('payload', { mode: 'json' }).notNull(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  error: text('error'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  timeoutMs: integer('timeout_ms').notNull().default(300000),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentReminders = sqliteTable('agent_reminders', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name'),
  prompt: text('prompt').notNull(),
  triggerAt: integer('trigger_at', { mode: 'timestamp' }).notNull(),
  recurringCron: text('recurring_cron'),
  enabled: integer('enabled').notNull().default(1),
  lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
