// === Enums ===

export type ScheduleType = 'cron' | 'webhook' | 'event';
export type ConcurrencyPolicy = 'queue' | 'replace' | 'forbid';
export type ExecutionMode = 'create_task' | 'run_only';
export type JobStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'skipped' | 'timeout';
export type SessionMode = 'new' | 'continue' | 'pool';

export type TriggerSource =
  | { type: 'cron' }
  | { type: 'webhook'; requestId: string }
  | { type: 'event'; eventName: string }
  | { type: 'manual' };

// === Row Types ===

export interface CronJobRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  cron_expression: string | null;
  interval_minutes: number | null;
  schedule_type: ScheduleType;
  webhook_secret: string | null;
  webhook_token: string | null;
  event_filter: string | null;
  concurrency_policy: ConcurrencyPolicy;
  execution_mode: ExecutionMode;
  admission_gate: number;
  prompt: string;
  chain_config: string | null;
  fan_out_config: string | null;
  session_mode: SessionMode;
  enabled: number;
  max_retries: number;
  retry_delay_ms: number;
  last_triggered_at: number | null;
  next_trigger_at: number | null;
  pause_reason: string | null;
  created_at: number;
}

export interface JobQueueRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  job_type: string;
  source_id: string | null;
  payload: string;
  status: JobStatus;
  priority: number;
  trace_id: string | null;
  claimed_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  output: string | null;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  created_at: number;
}

export interface CronExecutionRow {
  id: string;
  job_id: string;
  workspace_id: string;
  round_id: string | null;
  trigger_source: string;
  status: string;
  total_agents: number | null;
  completed_count: number;
  failed_count: number;
  trace_id: string | null;
  started_at: number;
  completed_at: number | null;
  summary: string | null;
  error: string | null;
}

export interface AgentReminderRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  name: string | null;
  prompt: string;
  trigger_at: number;
  recurring_cron: string | null;
  enabled: number;
  last_fired_at: number | null;
  created_at: number;
}

export interface WebhookAuditRow {
  id: string;
  job_id: string;
  request_id: string | null;
  source_ip: string | null;
  payload_hash: string | null;
  signature_valid: number | null;
  received_at: number;
}

// === Chain / Fan-out ===

export interface ChainConfig {
  steps: ChainStep[];
  approvalRequired?: string[];
}

export interface ChainStep {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  timeoutMs?: number;
}

export interface FanOutConfig {
  targets: string[];
}

// === Input Types ===

export interface CreateJobInput {
  workspaceId: string;
  agentId: string;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  cronExpression?: string;
  intervalMinutes?: number;
  webhookSecret?: string;
  eventFilter?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  executionMode?: ExecutionMode;
  admissionGate?: boolean;
  prompt: string;
  chainConfig?: ChainConfig;
  fanOutConfig?: FanOutConfig;
  sessionMode?: SessionMode;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface EnqueueInput {
  workspaceId: string;
  agentId: string;
  jobType: string;
  sourceId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  traceId?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface CreateReminderInput {
  agentId: string;
  workspaceId: string;
  name?: string;
  prompt: string;
  triggerAt: number;
  recurringCron?: string;
}

// === Decisions ===

export type ConcurrencyDecision =
  | { action: 'proceed' }
  | { action: 'queue' }
  | { action: 'replace'; killExecutionId: string }
  | { action: 'forbid'; reason: string };

export type AdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: string };

export type DispatchResult =
  | { ok: true; queueItemId: string; executionId: string }
  | { ok: false; reason: string; action: 'skipped' | 'queued' | 'forbidden' };

export interface WebhookResult {
  accepted: boolean;
  executionId?: string;
  error?: string;
}

export interface QueueStatus {
  pending: number;
  claimed: number;
  running: number;
  byAgent: Record<string, { pending: number; running: number }>;
}

// === Service Interfaces ===

export interface IJobQueue {
  enqueue(input: EnqueueInput): string;
  claim(agentId: string, jobTypes?: string[]): JobQueueRow | null;
  complete(jobId: string, output?: string): void;
  fail(jobId: string, error: string): boolean;
  retry(jobId: string): boolean;
  getDepth(agentId?: string): number;
  getStatus(workspaceId?: string): QueueStatus;
}

export interface ISchedulerService {
  createJob(input: CreateJobInput): string;
  updateJob(jobId: string, updates: Partial<CreateJobInput>): void;
  deleteJob(jobId: string): void;
  getJob(jobId: string): CronJobRow | null;
  listJobs(workspaceId?: string): CronJobRow[];
  pauseJob(jobId: string, reason: string): void;
  resumeJob(jobId: string): void;
  triggerNow(jobId: string): DispatchResult;
  getExecutionHistory(jobId: string, limit?: number): CronExecutionRow[];
  getQueueStatus(workspaceId?: string): QueueStatus;
  start(): void;
  stop(): void;
}

export interface IWebhookReceiver {
  handleIncoming(token: string, payload: unknown, signature?: string, sourceIp?: string): WebhookResult;
}

export interface ITriggerDispatcher {
  trigger(jobId: string, source: TriggerSource, payload?: unknown): DispatchResult;
}

export interface SchedulerConfig {
  enabled: boolean;
  cronTickIntervalMs: number;
  queuePollIntervalMs: number;
  defaultTimeoutMs: number;
  scriptTimeoutMs: number;
  maxOutputChars: number;
  autoPauseEnabled: boolean;
  autoPauseThreshold: number;
  autoPauseWindowDays: number;
  autoPauseMinExecutions: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: false,
  cronTickIntervalMs: 15_000,
  queuePollIntervalMs: 5_000,
  defaultTimeoutMs: 60_000,
  scriptTimeoutMs: 30_000,
  maxOutputChars: 8_000,
  autoPauseEnabled: true,
  autoPauseThreshold: 0.9,
  autoPauseWindowDays: 7,
  autoPauseMinExecutions: 50,
};
