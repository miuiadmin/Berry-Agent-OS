import type { TaskCheckpointManager } from './task-checkpoint.js';
import type { TaskManager, TaskManagerDb } from './task-manager.js';
import type { TaskRow } from './task-manager.js';
import type { EventBus } from './event-bus.js';
import type {
  ExecutionCheckpoint,
  ErrorType,
  ResumeStrategy,
  ResumeDecision,
  ResumeRequest,
  ResumeResult,
} from '../contracts/checkpoint.js';
import { MAX_RESUME_COUNT, CHECKPOINT_MAX_AGE_MS } from '../contracts/checkpoint.js';
import type { ErrorClassifier } from './error-classifier.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('checkpoint-service');

export class CheckpointService {
  constructor(
    private checkpointManager: TaskCheckpointManager,
    private taskManager: TaskManager,
    private errorClassifier: ErrorClassifier,
    private eventBus: EventBus,
  ) {}

  saveCheckpoint(checkpoint: ExecutionCheckpoint): void {
    this.checkpointManager.save(checkpoint.taskId, checkpoint.stepIndex, {
      executionId: checkpoint.executionId,
      messages: checkpoint.messages,
      toolState: checkpoint.toolState,
      lastOutput: checkpoint.lastOutput,
      metrics: checkpoint.metrics,
      savedAt: checkpoint.savedAt,
    });
    this.eventBus.emit('checkpoint.saved', { taskId: checkpoint.taskId, stepIndex: checkpoint.stepIndex });
  }

  getLatestCheckpoint(taskId: string): ExecutionCheckpoint | null {
    const raw = this.checkpointManager.getLatest(taskId);
    if (!raw) return null;

    const state = raw.state as Record<string, unknown>;
    return {
      taskId: raw.taskId,
      executionId: (state.executionId as string) ?? raw.taskId,
      stepIndex: raw.stepIndex,
      messages: (state.messages as ExecutionCheckpoint['messages']) ?? [],
      toolState: (state.toolState as ExecutionCheckpoint['toolState']) ?? [],
      lastOutput: (state.lastOutput as string) ?? '',
      metrics: (state.metrics as ExecutionCheckpoint['metrics']) ?? { tokenUsed: { input: 0, output: 0 }, toolCallCount: 0, durationMs: 0 },
      savedAt: raw.createdAt,
    };
  }

  markResumable(taskId: string, errorType: ErrorType, error: string): void {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Cannot mark resumable — task not found');
      return;
    }

    const db = (this.taskManager as TaskManagerDb).db;
    db.prepare(`
      UPDATE agent_tasks SET status = 'resumable', error = ?, error_type = ?, finished_at = ? WHERE id = ?
    `).run(error, errorType, Date.now(), taskId);

    this.eventBus.emit('task.resumable', { taskId, errorType, error });
    logger.info({ taskId, errorType }, 'Task marked resumable');
  }

  determineResumeStrategy(taskId: string): ResumeDecision {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      return { strategy: 'restart', reason: 'task not found' };
    }

    const resumeCount = task.resume_count ?? 0;
    const errorType = (task.error_type ?? 'permanent') as ErrorType;
    const checkpoint = this.getLatestCheckpoint(taskId);
    const hasCheckpoint = checkpoint !== null;

    if (resumeCount >= MAX_RESUME_COUNT) {
      return { strategy: 'restart', reason: `exceeded max resume count (${MAX_RESUME_COUNT})` };
    }

    if (checkpoint && checkpoint.savedAt < Date.now() - CHECKPOINT_MAX_AGE_MS) {
      return { strategy: 'restart', reason: 'checkpoint expired' };
    }

    const decision = this.errorClassifier.shouldAutoResume(errorType, resumeCount, hasCheckpoint);
    if (checkpoint) {
      decision.checkpoint = checkpoint;
    }
    return decision;
  }

  async resume(request: ResumeRequest): Promise<ResumeResult> {
    const task = this.taskManager.getTask(request.taskId);
    if (!task) {
      return { success: false, error: 'task not found' };
    }

    if (task.status !== 'resumable' && task.status !== 'failed') {
      return { success: false, error: `cannot resume task in status: ${task.status}` };
    }

    const strategy = request.strategy ?? this.determineResumeStrategy(request.taskId).strategy;

    const db = (this.taskManager as TaskManagerDb).db;

    if (strategy === 'restart') {
      db.prepare(`UPDATE agent_tasks SET status = 'failed', finished_at = ? WHERE id = ?`).run(Date.now(), request.taskId);
      this.checkpointManager.cleanup(request.taskId);
      this.eventBus.emit('task.resume.restart', { taskId: request.taskId });
      return { success: true, newTaskId: undefined };
    }

    db.prepare(`
      UPDATE agent_tasks SET status = 'running', resume_count = resume_count + 1, finished_at = NULL WHERE id = ?
    `).run(request.taskId);

    this.eventBus.emit('task.resumed', { taskId: request.taskId, strategy });
    logger.info({ taskId: request.taskId, strategy }, 'Task resumed');
    return { success: true };
  }

  recoverOnStartup(): { resumed: number; failed: number } {
    let resumed = 0;
    let failed = 0;

    const runningTasks = this.taskManager.getTasksByStatus('running');
    for (const task of runningTasks) {
      const checkpoint = this.getLatestCheckpoint(task.id);
      if (checkpoint && checkpoint.savedAt > Date.now() - CHECKPOINT_MAX_AGE_MS) {
        this.markResumable(task.id, 'transient', 'process restart');
        const decision = this.determineResumeStrategy(task.id);
        if (this.errorClassifier.canAutoResume('transient', task.resume_count ?? 0)) {
          const db = (this.taskManager as TaskManagerDb).db;
          db.prepare(`UPDATE agent_tasks SET status = 'running', resume_count = resume_count + 1 WHERE id = ?`).run(task.id);
          this.eventBus.emit('task.resumed', { taskId: task.id, strategy: decision.strategy });
          resumed++;
        } else {
          failed++;
        }
      } else {
        this.taskManager.fail(task.id, 'process restart — no valid checkpoint');
        failed++;
      }
    }

    if (resumed > 0 || failed > 0) {
      logger.info({ resumed, failed }, 'Startup recovery complete');
    }
    return { resumed, failed };
  }

  purgeExpired(): number {
    return this.checkpointManager.purgeOlderThan(CHECKPOINT_MAX_AGE_MS);
  }
}
