import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { AgentReminderRow, CreateReminderInput } from './contracts.js';
import type { TriggerDispatcher } from './trigger-dispatcher.js';
import { computeNextRun } from '../cron/parser.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('reminder-service');

export class ReminderService {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly dispatcher?: TriggerDispatcher,
  ) {}

  create(input: CreateReminderInput): string {
    const id = genId('rem');
    this.db.prepare(`
      INSERT INTO agent_reminders (id, agent_id, workspace_id, name, prompt, trigger_at, recurring_cron, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, input.agentId, input.workspaceId, input.name ?? null, input.prompt, input.triggerAt, input.recurringCron ?? null, Date.now());

    logger.debug({ id, agent: input.agentId, triggerAt: input.triggerAt }, 'Reminder created');
    return id;
  }

  cancel(reminderId: string): void {
    this.db.prepare('UPDATE agent_reminders SET enabled = 0 WHERE id = ?').run(reminderId);
  }

  delete(reminderId: string): void {
    this.db.prepare('DELETE FROM agent_reminders WHERE id = ?').run(reminderId);
  }

  list(agentId: string): AgentReminderRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_reminders WHERE agent_id = ? AND enabled = 1 ORDER BY trigger_at ASC'
    ).all(agentId) as AgentReminderRow[];
  }

  listAll(workspaceId?: string): AgentReminderRow[] {
    if (workspaceId) {
      return this.db.prepare(
        'SELECT * FROM agent_reminders WHERE workspace_id = ? ORDER BY trigger_at ASC'
      ).all(workspaceId) as AgentReminderRow[];
    }
    return this.db.prepare('SELECT * FROM agent_reminders ORDER BY trigger_at ASC').all() as AgentReminderRow[];
  }

  checkDue(now: number): AgentReminderRow[] {
    const due = this.db.prepare(
      'SELECT * FROM agent_reminders WHERE enabled = 1 AND trigger_at <= ?'
    ).all(now) as AgentReminderRow[];

    const fired: AgentReminderRow[] = [];

    for (const reminder of due) {
      this.eventBus.emit('scheduler.reminder_fired', {
        reminderId: reminder.id,
        agentId: reminder.agent_id,
      });

      // 13.0 §13.8: reminder 到点应真正派发任务给 agent（修复断尾）。
      // 之前只 emit + 更新 DB，提醒到点什么都不发生。
      // reminder.prompt 是要执行的提示，agent_id 是目标 agent。
      if (this.dispatcher && reminder.prompt) {
        try {
          this.dispatcher.trigger(`reminder:${reminder.id}`, { type: 'reminder', agentId: reminder.agent_id }, reminder.prompt);
          logger.info({ reminderId: reminder.id, agentId: reminder.agent_id }, 'Reminder dispatched to agent');
        } catch (err) {
          logger.warn({ err, reminderId: reminder.id }, 'Reminder dispatch failed');
        }
      }

      if (reminder.recurring_cron) {
        const nextTrigger = computeNextRun(reminder.recurring_cron, now);
        if (nextTrigger) {
          this.db.prepare(
            'UPDATE agent_reminders SET trigger_at = ?, last_fired_at = ? WHERE id = ?'
          ).run(nextTrigger, now, reminder.id);
        } else {
          this.db.prepare(
            'UPDATE agent_reminders SET enabled = 0, last_fired_at = ? WHERE id = ?'
          ).run(now, reminder.id);
        }
      } else {
        this.db.prepare(
          'UPDATE agent_reminders SET enabled = 0, last_fired_at = ? WHERE id = ?'
        ).run(now, reminder.id);
      }

      fired.push(reminder);
    }

    if (fired.length > 0) {
      logger.debug({ count: fired.length }, 'Reminders fired');
    }

    return fired;
  }

  purgeDisabled(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare(
      'DELETE FROM agent_reminders WHERE enabled = 0 AND last_fired_at < ?'
    ).run(cutoff);
    return result.changes;
  }
}
