import { eq, and, desc } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { agentExecutions, agentSessions, sessionMessages } from '../../db/schema/executions.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Execution = InferSelectModel<typeof agentExecutions>;
export type NewExecution = InferInsertModel<typeof agentExecutions>;
export type Session = InferSelectModel<typeof agentSessions>;
export type NewSession = InferInsertModel<typeof agentSessions>;
export type SessionMessage = InferSelectModel<typeof sessionMessages>;
export type NewSessionMessage = InferInsertModel<typeof sessionMessages>;

export class ExecutionRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Execution | undefined {
    return this.db.select().from(agentExecutions).where(eq(agentExecutions.id, id)).get();
  }

  findByAgent(agentId: string, limit = 20): Execution[] {
    return this.db.select().from(agentExecutions)
      .where(eq(agentExecutions.agentId, agentId))
      .orderBy(desc(agentExecutions.startedAt))
      .limit(limit)
      .all();
  }

  findByTask(taskId: string): Execution[] {
    return this.db.select().from(agentExecutions)
      .where(eq(agentExecutions.taskId, taskId))
      .orderBy(desc(agentExecutions.startedAt))
      .all();
  }

  findPendingReview(reviewerId: string): Execution[] {
    return this.db.select().from(agentExecutions)
      .where(and(
        eq(agentExecutions.reviewedBy, reviewerId),
        eq(agentExecutions.reviewStatus, 'pending'),
      ))
      .all();
  }

  insert(execution: NewExecution): void {
    this.db.insert(agentExecutions).values(execution).run();
  }

  update(id: string, data: Partial<Omit<NewExecution, 'id'>>): void {
    this.db.update(agentExecutions).set(data).where(eq(agentExecutions.id, id)).run();
  }

  // Sessions
  findSessionById(id: string): Session | undefined {
    return this.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  }

  findSessionsByAgent(agentId: string): Session[] {
    return this.db.select().from(agentSessions)
      .where(eq(agentSessions.agentId, agentId))
      .orderBy(desc(agentSessions.updatedAt))
      .all();
  }

  insertSession(session: NewSession): void {
    this.db.insert(agentSessions).values(session).run();
  }

  updateSession(id: string, data: Partial<Omit<NewSession, 'id'>>): void {
    this.db.update(agentSessions).set(data).where(eq(agentSessions.id, id)).run();
  }

  // Messages
  findMessages(sessionId: string): SessionMessage[] {
    return this.db.select().from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .all();
  }

  insertMessage(message: NewSessionMessage): void {
    this.db.insert(sessionMessages).values(message).run();
  }
}
