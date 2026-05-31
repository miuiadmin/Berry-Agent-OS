import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { MemoryRepository } from './memory.repository.js';
import type { AgentMemory, WorkspaceMemory, GlobalMemory } from './memory.repository.js';

export interface CreateAgentMemoryInput {
  agentId: string;
  workspaceId?: string;
  type: 'skill' | 'preference' | 'knowledge' | 'feedback';
  content: string;
  source?: string;
  importance?: number;
}

export interface CreateWorkspaceMemoryInput {
  workspaceId: string;
  ownerAgentId?: string;
  type: 'knowledge' | 'preference' | 'feedback' | 'context';
  content: string;
  origin?: 'evolved' | 'manual' | 'imported';
  visibility?: 'private' | 'workspace';
  importance?: number;
  tags?: string[];
}

export interface CreateGlobalMemoryInput {
  userId: string;
  type: 'knowledge' | 'preference' | 'feedback' | 'context';
  content: string;
  origin?: 'evolved' | 'manual' | 'promoted';
  sourceWorkspaceId?: string;
  sourceMemoryId?: string;
  importance?: number;
  tags?: string[];
}

export class MemoryService {
  constructor(
    private repo: MemoryRepository,
    private events: AppEvents,
  ) {}

  createAgentMemory(input: CreateAgentMemoryInput): AgentMemory {
    const id = genId();
    const now = new Date();
    const memory = {
      id,
      agentId: input.agentId,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      content: input.content,
      source: input.source ?? null,
      importance: input.importance ?? 0.5,
      accessCount: 0,
      publishedPluginId: null,
      lastAccessedAt: null,
      createdAt: now,
    };
    this.repo.insertAgentMemory(memory);
    this.events.emit('memory.created', { memoryId: id, scope: 'agent' });
    return memory as AgentMemory;
  }

  createWorkspaceMemory(input: CreateWorkspaceMemoryInput): WorkspaceMemory {
    const id = genId();
    const now = new Date();
    const memory = {
      id,
      workspaceId: input.workspaceId,
      ownerAgentId: input.ownerAgentId ?? null,
      type: input.type,
      content: input.content,
      origin: input.origin ?? 'evolved',
      visibility: input.visibility ?? 'private',
      importance: input.importance ?? 0.5,
      tags: input.tags ?? null,
      recallCount: 0,
      verifiedAt: null,
      sourceExecutionId: null,
      archived: 0,
      lastRecalledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertWorkspaceMemory(memory);
    this.events.emit('memory.created', { memoryId: id, scope: 'workspace' });
    return memory as WorkspaceMemory;
  }

  createGlobalMemory(input: CreateGlobalMemoryInput): GlobalMemory {
    const id = genId();
    const now = new Date();
    const memory = {
      id,
      userId: input.userId,
      type: input.type,
      content: input.content,
      origin: input.origin ?? 'evolved',
      sourceWorkspaceId: input.sourceWorkspaceId ?? null,
      sourceMemoryId: input.sourceMemoryId ?? null,
      importance: input.importance ?? 0.6,
      tags: input.tags ?? null,
      recallCount: 0,
      verifiedAt: null,
      archived: 0,
      lastRecalledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertGlobalMemory(memory);
    this.events.emit('memory.created', { memoryId: id, scope: 'global' });
    return memory as GlobalMemory;
  }

  getAgentMemories(agentId: string): AgentMemory[] {
    return this.repo.findAgentMemories(agentId);
  }

  getWorkspaceMemories(workspaceId: string): WorkspaceMemory[] {
    return this.repo.findWorkspaceMemories(workspaceId);
  }

  getGlobalMemories(userId: string): GlobalMemory[] {
    return this.repo.findGlobalMemories(userId);
  }

  bindMemoryToAgent(agentId: string, memoryId: string, source: string): void {
    this.repo.insertBinding({
      id: genId(),
      agentId,
      memoryId,
      source,
      enabled: 1,
      pinned: 0,
      assignedBy: null,
      createdAt: new Date(),
    });
  }

  unbindMemory(agentId: string, memoryId: string): void {
    this.repo.deleteBinding(agentId, memoryId);
  }

  promoteToGlobal(workspaceMemoryId: string, userId: string): GlobalMemory {
    const wsMemories = this.repo.findWorkspaceMemories('');
    const wsMemory = wsMemories.find(m => m.id === workspaceMemoryId);
    if (!wsMemory) throw new Error(`Workspace memory not found: ${workspaceMemoryId}`);

    return this.createGlobalMemory({
      userId,
      type: wsMemory.type as "preference" | "knowledge" | "context" | "feedback",
      content: wsMemory.content,
      origin: 'promoted',
      sourceWorkspaceId: wsMemory.workspaceId,
      sourceMemoryId: wsMemory.id,
      importance: wsMemory.importance,
      tags: wsMemory.tags as string[] | undefined,
    });
  }
}
