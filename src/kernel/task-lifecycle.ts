import type { Database } from 'better-sqlite3';
import type { EventBus } from './event-bus.js';
import type { AgentName, TaskStatus } from '../contracts/agents.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('task-lifecycle');

export type TaskVisibility = 'foreground' | 'backgrounded' | 'retrieved';
export type TaskNotifyState = 'none' | 'pending' | 'notified' | 'dismissed';

export interface BackgroundTaskSummary {
  taskId: string;
  taskType: string;
  targetAgent: AgentName;
  status: TaskStatus;
  visibility: TaskVisibility;
  notifyState: TaskNotifyState;
  startedAt: number | null;
  durationMs: number;
  summary?: string;
}

export interface TaskLifecycleState {
  taskId: string;
  visibility: TaskVisibility;
  notifyState: TaskNotifyState;
  backgroundedAt: number | null;
  retrievedAt: number | null;
  notifiedAt: number | null;
}

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'timeout', 'cancelled'];

export class TaskLifecycle {
  constructor(
    private readonly db: Database,
    private readonly eventBus: EventBus,
  ) {
    this.eventBus.on('task.completed', ({ taskId }) => this.onTaskTerminal(taskId));
    this.eventBus.on('task.failed', ({ taskId }) => this.onTaskTerminal(taskId));
    this.eventBus.on('task.timeout', ({ taskId }) => this.onTaskTerminal(taskId));
  }

  background(taskId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_tasks SET visibility = 'backgrounded', backgrounded_at = ? WHERE id = ?
    `).run(now, taskId);
    this.eventBus.emit('task.backgrounded', { taskId });
  }

  retrieve(taskId: string): TaskLifecycleState {
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_tasks SET visibility = 'retrieved', retrieved_at = ?, notify_state = 'notified', notified_at = ? WHERE id = ?
    `).run(now, now, taskId);
    this.eventBus.emit('task.retrieved', { taskId });
    return this.getState(taskId)!;
  }

  resume(taskId: string): void {
    this.db.prepare(`
      UPDATE agent_tasks SET visibility = 'foreground' WHERE id = ?
    `).run(taskId);
    this.eventBus.emit('task.resumed', { taskId });
  }

  stop(taskId: string, reason?: string): void {
    const now = Date.now();
    const task = this.db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(taskId) as { status: TaskStatus } | undefined;
    if (!task) return;
    if (TERMINAL_STATUSES.includes(task.status)) return;

    this.db.prepare(`
      UPDATE agent_tasks SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?
    `).run(reason ?? '用户停止', now, taskId);
    this.eventBus.emit('task.cancelled', { taskId, reason });
  }

  markNotified(taskId: string): void {
    this.db.prepare(`
      UPDATE agent_tasks SET notify_state = 'notified', notified_at = ? WHERE id = ?
    `).run(Date.now(), taskId);
  }

  dismissNotification(taskId: string): void {
    this.db.prepare(`
      UPDATE agent_tasks SET notify_state = 'dismissed' WHERE id = ?
    `).run(taskId);
  }

  getState(taskId: string): TaskLifecycleState | null {
    const row = this.db.prepare(`
      SELECT id, visibility, notify_state, backgrounded_at, retrieved_at, notified_at
      FROM agent_tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      taskId: row.id as string,
      visibility: (row.visibility as TaskVisibility) ?? 'foreground',
      notifyState: (row.notify_state as TaskNotifyState) ?? 'none',
      backgroundedAt: (row.backgrounded_at as number) ?? null,
      retrievedAt: (row.retrieved_at as number) ?? null,
      notifiedAt: (row.notified_at as number) ?? null,
    };
  }

  listBackground(sessionId: string): BackgroundTaskSummary[] {
    const rows = this.db.prepare(`
      SELECT id, task_type, target_agent, status, visibility, notify_state, started_at, finished_at, output_payload
      FROM agent_tasks
      WHERE session_id = ? AND visibility IN ('backgrounded', 'retrieved')
      ORDER BY created_at DESC
    `).all(sessionId) as Record<string, unknown>[];

    const now = Date.now();
    return rows.map(row => {
      const startedAt = row.started_at as number | null;
      const finishedAt = row.finished_at as number | null;
      const durationMs = startedAt ? (finishedAt ?? now) - startedAt : 0;
      let summary: string | undefined;
      if (row.output_payload) {
        try {
          const out = JSON.parse(row.output_payload as string);
          summary = out.summary ?? out.kind;
        } catch (err) {
          logger.debug({ err, taskId: row.id }, '任务 output_payload 解析失败');
        }
      }
      return {
        taskId: row.id as string,
        taskType: row.task_type as string,
        targetAgent: row.target_agent as AgentName,
        status: row.status as TaskStatus,
        visibility: (row.visibility as TaskVisibility) ?? 'backgrounded',
        notifyState: (row.notify_state as TaskNotifyState) ?? 'none',
        startedAt,
        durationMs,
        summary,
      };
    });
  }

  getPendingNotifications(sessionId: string): BackgroundTaskSummary[] {
    return this.listBackground(sessionId).filter(t => t.notifyState === 'pending');
  }

  private onTaskTerminal(taskId: string): void {
    const row = this.db.prepare(
      `SELECT visibility, notify_state FROM agent_tasks WHERE id = ?`,
    ).get(taskId) as Record<string, unknown> | undefined;

    if (!row) return;
    if (row.visibility === 'backgrounded' && row.notify_state !== 'notified') {
      this.db.prepare(`
        UPDATE agent_tasks SET notify_state = 'pending' WHERE id = ?
      `).run(taskId);
    }
  }
}
