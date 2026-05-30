import type { Database } from 'better-sqlite3';
import type { EventBus } from './event-bus.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('task-notification');

export interface TaskNotification {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  summary: string;
  result?: string;
  usage: { inputTokens: number; outputTokens: number };
  toolUses: Array<{ name: string; durationMs: number }>;
  durationMs: number;
  createdAt: number;
}

export class TaskNotifier {
  private db: Database;
  private eventBus: EventBus;

  constructor(db: Database, eventBus: EventBus) {
    this.db = db;
    this.eventBus = eventBus;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.eventBus.on('task.completed', (payload) => {
      this.generateNotification(payload.taskId, 'completed', payload.outputPayload);
    });

    this.eventBus.on('task.failed', (payload) => {
      this.generateNotification(payload.taskId, 'failed', { error: payload.error });
    });

    this.eventBus.on('task.timeout', (payload) => {
      this.generateNotification(payload.taskId, 'timeout', {});
    });
  }

  private generateNotification(
    taskId: string,
    status: 'completed' | 'failed' | 'timeout',
    outputPayload: Record<string, unknown>,
  ): void {
    try {
      const task = this.db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
      if (!task) return;

      const sessionId = task.session_id as string;
      const startedAt = (task.started_at as number | null) ?? (task.created_at as number);
      const finishedAt = (task.finished_at as number | null) ?? Date.now();
      const durationMs = finishedAt - startedAt;

      const toolUses = this.getToolUses(taskId);
      const usage = this.getUsage(sessionId, startedAt, finishedAt);

      const summary = this.buildSummary(status, outputPayload, durationMs);
      const result = status === 'completed' ? (outputPayload.response as string | undefined) : undefined;

      const notification: TaskNotification = {
        taskId,
        status,
        summary,
        result,
        usage,
        toolUses,
        durationMs,
        createdAt: Date.now(),
      };

      this.db.prepare(`
        INSERT INTO task_events (id, task_id, session_id, source, event_type, level, message, payload, created_at)
        VALUES (?, ?, ?, 'core', 'notification', 'info', ?, ?, ?)
      `).run(
        genId('evt'),
        taskId,
        sessionId,
        summary,
        JSON.stringify(notification),
        notification.createdAt,
      );

      this.eventBus.emit('task.notification', {
        taskId,
        notification: { ...notification } as Record<string, unknown>,
      });

      logger.debug({ taskId, status, durationMs }, '任务通知已生成');
    } catch (err) {
      logger.error({ err, taskId }, '生成任务通知失败');
    }
  }

  private getToolUses(taskId: string): Array<{ name: string; durationMs: number }> {
    const rows = this.db.prepare(`
      SELECT tool_name, started_at, finished_at FROM tool_calls WHERE task_id = ?
    `).all(taskId) as Array<{ tool_name: string; started_at: number; finished_at: number | null }>;

    return rows.map((r) => ({
      name: r.tool_name,
      durationMs: (r.finished_at ?? Date.now()) - r.started_at,
    }));
  }

  private getUsage(sessionId: string, startedAt: number, finishedAt: number): { inputTokens: number; outputTokens: number } {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM token_usage
      WHERE session_id = ? AND created_at >= ? AND created_at <= ?
    `).get(sessionId, startedAt, finishedAt) as { input_tokens: number; output_tokens: number };

    return { inputTokens: row.input_tokens, outputTokens: row.output_tokens };
  }

  private buildSummary(
    status: 'completed' | 'failed' | 'timeout',
    outputPayload: Record<string, unknown>,
    durationMs: number,
  ): string {
    const duration = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;

    switch (status) {
      case 'completed':
        return `任务完成 (${duration})`;
      case 'failed':
        return `任务失败: ${(outputPayload.error as string) ?? '未知错误'} (${duration})`;
      case 'timeout':
        return `任务超时 (${duration})`;
    }
  }

  getLastNotification(taskId: string): TaskNotification | null {
    const row = this.db.prepare(`
      SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'notification' ORDER BY created_at DESC LIMIT 1
    `).get(taskId) as { payload: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.payload) as TaskNotification;
  }

  getNotifications(sessionId: string): TaskNotification[] {
    const rows = this.db.prepare(`
      SELECT payload FROM task_events WHERE session_id = ? AND event_type = 'notification' ORDER BY created_at ASC
    `).all(sessionId) as Array<{ payload: string }>;

    return rows.map((r) => JSON.parse(r.payload) as TaskNotification);
  }
}
