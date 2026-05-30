import { eq, and, lte, asc } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { jobQueue } from '../db/schema/scheduler.js';
import { genId } from '../utils/id.js';

export interface QueueJob {
  id: string;
  workspaceId: string;
  agentId: string;
  jobType: string;
  sourceId: string | null;
  payload: unknown;
  status: string;
  priority: number;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  createdAt: Date;
}

export interface EnqueueParams {
  workspaceId: string;
  agentId: string;
  jobType: string;
  sourceId?: string;
  payload: unknown;
  priority?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export class JobQueueService {
  constructor(private db: AppDb) {}

  enqueue(params: EnqueueParams): string {
    const id = genId();
    const now = new Date();
    this.db.insert(jobQueue).values({
      id,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      jobType: params.jobType,
      sourceId: params.sourceId ?? null,
      payload: params.payload as any,
      status: 'pending',
      priority: params.priority ?? 0,
      retryCount: 0,
      maxRetries: params.maxRetries ?? 3,
      timeoutMs: params.timeoutMs ?? 300000,
      createdAt: now,
    }).run();
    return id;
  }

  claim(agentId: string): QueueJob | null {
    const now = new Date();
    const job = this.db
      .select()
      .from(jobQueue)
      .where(and(
        eq(jobQueue.agentId, agentId),
        eq(jobQueue.status, 'pending'),
      ))
      .orderBy(asc(jobQueue.priority), asc(jobQueue.createdAt))
      .limit(1)
      .get();

    if (!job) return null;

    this.db.update(jobQueue)
      .set({ status: 'claimed', claimedAt: now })
      .where(eq(jobQueue.id, job.id))
      .run();

    return job as QueueJob;
  }

  start(jobId: string): void {
    this.db.update(jobQueue)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(jobQueue.id, jobId))
      .run();
  }

  complete(jobId: string): void {
    this.db.update(jobQueue)
      .set({ status: 'done', completedAt: new Date() })
      .where(eq(jobQueue.id, jobId))
      .run();
  }

  fail(jobId: string, error: string): void {
    const job = this.db.select().from(jobQueue).where(eq(jobQueue.id, jobId)).get();
    if (!job) return;

    if (job.retryCount < job.maxRetries) {
      this.db.update(jobQueue)
        .set({ status: 'pending', error, retryCount: job.retryCount + 1 })
        .where(eq(jobQueue.id, jobId))
        .run();
    } else {
      this.db.update(jobQueue)
        .set({ status: 'failed', error, completedAt: new Date() })
        .where(eq(jobQueue.id, jobId))
        .run();
    }
  }

  getPending(workspaceId: string): QueueJob[] {
    return this.db
      .select()
      .from(jobQueue)
      .where(and(
        eq(jobQueue.workspaceId, workspaceId),
        eq(jobQueue.status, 'pending'),
      ))
      .orderBy(asc(jobQueue.priority), asc(jobQueue.createdAt))
      .all() as QueueJob[];
  }
}
