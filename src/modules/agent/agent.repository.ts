import { eq, and, isNull } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { agents } from '../../db/schema/agents.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Agent = InferSelectModel<typeof agents>;
export type NewAgent = InferInsertModel<typeof agents>;

export class AgentRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Agent | undefined {
    return this.db.select().from(agents).where(eq(agents.id, id)).get();
  }

  findByWorkspace(workspaceId: string): Agent[] {
    return this.db.select().from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)))
      .all();
  }

  findByUser(userId: string): Agent[] {
    return this.db.select().from(agents).where(eq(agents.userId, userId)).all();
  }

  findGlobalAssistant(userId: string): Agent | undefined {
    return this.db.select().from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.agentType, 'global')))
      .get();
  }

  findBySuperior(superiorId: string): Agent[] {
    return this.db.select().from(agents).where(eq(agents.superiorId, superiorId)).all();
  }

  findLeaders(workspaceId: string): Agent[] {
    return this.db.select().from(agents)
      .where(and(
        eq(agents.workspaceId, workspaceId),
        isNull(agents.superiorId),
        eq(agents.agentType, 'team'),
      ))
      .all();
  }

  insert(agent: NewAgent): void {
    this.db.insert(agents).values(agent).run();
  }

  update(id: string, data: Partial<Omit<NewAgent, 'id'>>): void {
    this.db.update(agents).set(data).where(eq(agents.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(agents).where(eq(agents.id, id)).run();
  }
}
