import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { cronJobs, cronExecutions, agentReminders } from '../../db/schema/scheduler.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type CronJob = InferSelectModel<typeof cronJobs>;
export type NewCronJob = InferInsertModel<typeof cronJobs>;
export type CronExecution = InferSelectModel<typeof cronExecutions>;
export type Reminder = InferSelectModel<typeof agentReminders>;
export type NewReminder = InferInsertModel<typeof agentReminders>;

export class SchedulerRepository {
  constructor(private db: AppDb) {}

  findJobById(id: string): CronJob | undefined {
    return this.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  }

  findJobsByWorkspace(workspaceId: string): CronJob[] {
    return this.db.select().from(cronJobs).where(eq(cronJobs.workspaceId, workspaceId)).all();
  }

  findJobsByAgent(agentId: string): CronJob[] {
    return this.db.select().from(cronJobs).where(eq(cronJobs.agentId, agentId)).all();
  }

  findEnabledJobs(): CronJob[] {
    return this.db.select().from(cronJobs).where(eq(cronJobs.enabled, 1)).all();
  }

  insertJob(job: NewCronJob): void {
    this.db.insert(cronJobs).values(job).run();
  }

  updateJob(id: string, data: Partial<Omit<NewCronJob, 'id'>>): void {
    this.db.update(cronJobs).set(data).where(eq(cronJobs.id, id)).run();
  }

  deleteJob(id: string): void {
    this.db.delete(cronJobs).where(eq(cronJobs.id, id)).run();
  }

  insertExecution(exec: InferInsertModel<typeof cronExecutions>): void {
    this.db.insert(cronExecutions).values(exec).run();
  }

  updateExecution(id: string, data: Partial<InferInsertModel<typeof cronExecutions>>): void {
    this.db.update(cronExecutions).set(data).where(eq(cronExecutions.id, id)).run();
  }

  // Reminders
  findRemindersByAgent(agentId: string): Reminder[] {
    return this.db.select().from(agentReminders)
      .where(and(eq(agentReminders.agentId, agentId), eq(agentReminders.enabled, 1)))
      .all();
  }

  insertReminder(reminder: NewReminder): void {
    this.db.insert(agentReminders).values(reminder).run();
  }

  updateReminder(id: string, data: Partial<Omit<NewReminder, 'id'>>): void {
    this.db.update(agentReminders).set(data).where(eq(agentReminders.id, id)).run();
  }

  deleteReminder(id: string): void {
    this.db.delete(agentReminders).where(eq(agentReminders.id, id)).run();
  }
}
