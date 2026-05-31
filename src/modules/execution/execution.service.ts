import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { ExecutionRepository } from './execution.repository.js';
import type { Execution, Session, SessionMessage } from './execution.repository.js';

export type TriggerType = 'manual' | 'cron' | 'chain' | 'reminder' | 'task_assign' | 'fan_out' | 'redo' | 'supplement' | 'reassign' | 'review' | 'aggregation' | 'webhook' | 'event';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'resumable';
export type ReviewStatus = 'pending' | 'approved' | 'modified' | 'rejected' | 'reassigned' | 'supplemented' | 'suspended' | 'review_failed';

export interface StartExecutionInput {
  workspaceId?: string;
  agentId: string;
  taskId?: string;
  jobId?: string;
  traceId?: string;
  triggerType: TriggerType;
  inputPrompt?: string;
  previousExecutionId?: string;
  reviewedBy?: string;
}

export interface CompleteExecutionInput {
  executionId: string;
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalCost?: number;
  toolCalls?: number;
}

export interface CreateSessionInput {
  workspaceId?: string;
  agentId: string;
  title?: string;
  sessionType: 'user_chat' | 'execution' | 'chain' | 'delegate';
}

export class ExecutionService {
  constructor(
    private repo: ExecutionRepository,
    private events: AppEvents,
  ) {}

  /** Low-level update for service integrations (review, etc.) */
  updateExecution(id: string, data: Parameters<ExecutionRepository['update']>[1]): void {
    this.repo.update(id, data);
  }

  start(input: StartExecutionInput): Execution {
    const id = genId();
    const now = new Date();
    const execution = {
      id,
      workspaceId: input.workspaceId ?? null,
      agentId: input.agentId,
      taskId: input.taskId ?? null,
      jobId: input.jobId ?? null,
      traceId: input.traceId ?? null,
      triggerType: input.triggerType,
      status: 'running',
      phase: 'running',
      inputPrompt: input.inputPrompt ?? null,
      output: null,
      inputTokens: null,
      outputTokens: null,
      cacheTokens: null,
      totalCost: null,
      toolCalls: 0,
      errorType: null,
      progressData: null,
      checkpoint: null,
      reviewStatus: 'pending',
      reviewedBy: input.reviewedBy ?? null,
      reviewNote: null,
      reviewGuidance: null,
      reviewActionData: null,
      reviewRetryCount: 0,
      reviewEscalatedTo: null,
      redoCount: 0,
      previousExecutionId: input.previousExecutionId ?? null,
      durationMs: null,
      startedAt: now,
      completedAt: null,
      error: null,
    };
    this.repo.insert(execution);
    this.events.emit('execution.started', {
      executionId: id,
      agentId: input.agentId,
      taskId: input.taskId ?? null,
    });
    return execution as Execution;
  }

  complete(input: CompleteExecutionInput): void {
    const now = new Date();
    const execution = this.repo.findById(input.executionId);
    if (!execution) return;

    const durationMs = now.getTime() - execution.startedAt.getTime();
    this.repo.update(input.executionId, {
      status: 'completed',
      phase: 'done',
      output: input.output ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheTokens: input.cacheTokens ?? null,
      totalCost: input.totalCost ?? null,
      toolCalls: input.toolCalls ?? 0,
      durationMs,
      completedAt: now,
    });
    this.events.emit('execution.completed', {
      executionId: input.executionId,
      agentId: execution.agentId,
      status: 'completed',
    });
  }

  fail(executionId: string, error: string, errorType?: string): void {
    const now = new Date();
    const execution = this.repo.findById(executionId);
    if (!execution) return;

    const durationMs = now.getTime() - execution.startedAt.getTime();
    this.repo.update(executionId, {
      status: 'failed',
      phase: 'done',
      error,
      errorType: errorType ?? 'permanent',
      durationMs,
      completedAt: now,
    });
    this.events.emit('execution.failed', {
      executionId,
      agentId: execution.agentId,
      error,
    });
  }

  getById(id: string): Execution | undefined {
    return this.repo.findById(id);
  }

  listByAgent(agentId: string, limit?: number): Execution[] {
    return this.repo.findByAgent(agentId, limit);
  }

  listByTask(taskId: string): Execution[] {
    return this.repo.findByTask(taskId);
  }

  getPendingReviews(reviewerId: string): Execution[] {
    return this.repo.findPendingReview(reviewerId);
  }

  updatePhase(executionId: string, phase: string): void {
    this.repo.update(executionId, { phase });
  }

  updateProgress(executionId: string, progressData: unknown): void {
    this.repo.update(executionId, { progressData: progressData as any });
  }

  // Session management
  createSession(input: CreateSessionInput): Session {
    const id = genId();
    const now = new Date();
    const session = {
      id,
      workspaceId: input.workspaceId ?? null,
      agentId: input.agentId,
      title: input.title ?? null,
      sessionType: input.sessionType,
      status: 'active',
      messageCount: 0,
      totalTokens: 0,
      compressedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertSession(session);
    return session as Session;
  }

  addMessage(sessionId: string, role: string, content: string, metadata?: unknown): SessionMessage {
    const id = genId();
    const now = new Date();
    const message = {
      id,
      sessionId,
      role,
      content,
      metadata: (metadata ?? null) as any,
      createdAt: now,
    };
    this.repo.insertMessage(message);
    this.repo.updateSession(sessionId, { updatedAt: now });
    return message as SessionMessage;
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    return this.repo.findMessages(sessionId);
  }

  getSession(sessionId: string): Session | undefined {
    return this.repo.findSessionById(sessionId);
  }

  listSessions(agentId: string): Session[] {
    return this.repo.findSessionsByAgent(agentId);
  }
}
