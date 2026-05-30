import type Database from 'better-sqlite3';
import type { EventBus } from './event-bus.js';
import { genId } from '../utils/id.js';

export type ProgressLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AgentProgressInput {
  taskId: string;
  sessionId: string;
  source: string;
  message: string;
  level?: ProgressLevel;
  payload?: Record<string, unknown>;
}

export class AgentProgress {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
  ) {}

  report(input: AgentProgressInput): void {
    const level = input.level ?? 'info';
    const payload = input.payload ?? {};

    this.db.prepare(`
      INSERT INTO task_events (id, task_id, session_id, source, event_type, level, message, payload, created_at)
      VALUES (?, ?, ?, ?, 'progress', ?, ?, ?, ?)
    `).run(
      genId('evt'),
      input.taskId,
      input.sessionId,
      input.source,
      level,
      input.message,
      JSON.stringify(payload),
      Date.now(),
    );

    this.eventBus.emit('task.progress', {
      taskId: input.taskId,
      message: input.message,
      payload,
    });
  }
}
