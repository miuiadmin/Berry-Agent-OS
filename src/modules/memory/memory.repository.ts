import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { agentMemories, workspaceMemories, agentMemoryBindings, globalMemories } from '../../db/schema/memory.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type AgentMemory = InferSelectModel<typeof agentMemories>;
export type NewAgentMemory = InferInsertModel<typeof agentMemories>;
export type WorkspaceMemory = InferSelectModel<typeof workspaceMemories>;
export type NewWorkspaceMemory = InferInsertModel<typeof workspaceMemories>;
export type MemoryBinding = InferSelectModel<typeof agentMemoryBindings>;
export type GlobalMemory = InferSelectModel<typeof globalMemories>;
export type NewGlobalMemory = InferInsertModel<typeof globalMemories>;

export class MemoryRepository {
  constructor(private db: AppDb) {}

  // Agent memories
  findAgentMemories(agentId: string): AgentMemory[] {
    return this.db.select().from(agentMemories).where(eq(agentMemories.agentId, agentId)).all();
  }

  insertAgentMemory(memory: NewAgentMemory): void {
    this.db.insert(agentMemories).values(memory).run();
  }

  updateAgentMemory(id: string, data: Partial<Omit<NewAgentMemory, 'id'>>): void {
    this.db.update(agentMemories).set(data).where(eq(agentMemories.id, id)).run();
  }

  deleteAgentMemory(id: string): void {
    this.db.delete(agentMemories).where(eq(agentMemories.id, id)).run();
  }

  // Workspace memories
  findWorkspaceMemories(workspaceId: string): WorkspaceMemory[] {
    return this.db.select().from(workspaceMemories)
      .where(and(eq(workspaceMemories.workspaceId, workspaceId), eq(workspaceMemories.archived, 0)))
      .all();
  }

  insertWorkspaceMemory(memory: NewWorkspaceMemory): void {
    this.db.insert(workspaceMemories).values(memory).run();
  }

  updateWorkspaceMemory(id: string, data: Partial<Omit<NewWorkspaceMemory, 'id'>>): void {
    this.db.update(workspaceMemories).set(data).where(eq(workspaceMemories.id, id)).run();
  }

  // Bindings
  findBindings(agentId: string): MemoryBinding[] {
    return this.db.select().from(agentMemoryBindings).where(eq(agentMemoryBindings.agentId, agentId)).all();
  }

  insertBinding(binding: InferInsertModel<typeof agentMemoryBindings>): void {
    this.db.insert(agentMemoryBindings).values(binding).run();
  }

  deleteBinding(agentId: string, memoryId: string): void {
    this.db.delete(agentMemoryBindings)
      .where(and(eq(agentMemoryBindings.agentId, agentId), eq(agentMemoryBindings.memoryId, memoryId)))
      .run();
  }

  // Global memories
  findGlobalMemories(userId: string): GlobalMemory[] {
    return this.db.select().from(globalMemories)
      .where(and(eq(globalMemories.userId, userId), eq(globalMemories.archived, 0)))
      .all();
  }

  insertGlobalMemory(memory: NewGlobalMemory): void {
    this.db.insert(globalMemories).values(memory).run();
  }

  updateGlobalMemory(id: string, data: Partial<Omit<NewGlobalMemory, 'id'>>): void {
    this.db.update(globalMemories).set(data).where(eq(globalMemories.id, id)).run();
  }
}
