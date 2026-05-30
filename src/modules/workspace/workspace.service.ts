import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { WorkspaceRepository } from './workspace.repository.js';
import type { Workspace, WorkspaceMember } from './workspace.repository.js';
import type { OrgService } from '../org/org.service.js';
import type { AgentService } from '../agent/agent.service.js';

export interface CreateWorkspaceInput {
  ownerId: string;
  name: string;
  slug: string;
  description?: string;
  issuePrefix?: string;
  reviewMode?: 'strict' | 'trust_based';
}

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
}

export class WorkspaceService {
  private orgService: OrgService | null = null;
  private agentService: AgentService | null = null;

  constructor(
    private repo: WorkspaceRepository,
    private events: AppEvents,
  ) {}

  setOrgService(org: OrgService): void {
    this.orgService = org;
  }

  setAgentService(agent: AgentService): void {
    this.agentService = agent;
  }

  create(input: CreateWorkspaceInput): Workspace {
    const id = genId();
    const now = new Date();
    const workspace = {
      id,
      ownerId: input.ownerId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      issuePrefix: input.issuePrefix ?? null,
      issueCounter: 0,
      context: null,
      reviewMode: input.reviewMode ?? 'trust_based',
      createdAt: now,
    };
    this.repo.insert(workspace);
    this.repo.insertMember({
      id: genId(),
      workspaceId: id,
      userId: input.ownerId,
      role: 'owner',
      joinedAt: now,
    });

    if (this.orgService) {
      const rootNode = this.orgService.create({
        workspaceId: id,
        name: input.name,
        type: 'root',
      });

      if (this.agentService) {
        this.agentService.create({
          workspaceId: id,
          orgNodeId: rootNode.id,
          userId: input.ownerId,
          agentType: 'team',
          name: `${input.name} Leader`,
          roleDescription: 'Team leader — reviews all subordinate outputs, has full capabilities',
          provider: 'anthropic',
          config: { model: 'claude-sonnet-4-20250514' },
          thinkingLevel: 'high',
          l2Capabilities: ['learning', 'skills', 'code', 'tools', 'search', 'memory', 'decompose', 'review'],
        });
      }
    }

    this.events.emit('workspace.created', { workspaceId: id, ownerId: input.ownerId });
    return workspace;
  }

  getById(id: string): Workspace | undefined {
    return this.repo.findById(id);
  }

  getBySlug(slug: string): Workspace | undefined {
    return this.repo.findBySlug(slug);
  }

  listByOwner(ownerId: string): Workspace[] {
    return this.repo.findByOwner(ownerId);
  }

  update(id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'context' | 'reviewMode'>>): void {
    this.repo.update(id, data);
    this.events.emit('workspace.updated', { workspaceId: id });
  }

  delete(id: string): void {
    this.repo.delete(id);
    this.events.emit('workspace.deleted', { workspaceId: id });
  }

  addMember(input: AddMemberInput): void {
    this.repo.insertMember({
      id: genId(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      joinedAt: new Date(),
    });
    this.events.emit('workspace.member.added', {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
    });
  }

  removeMember(workspaceId: string, userId: string): void {
    this.repo.removeMember(workspaceId, userId);
    this.events.emit('workspace.member.removed', { workspaceId, userId });
  }

  getMembers(workspaceId: string): WorkspaceMember[] {
    return this.repo.findMembers(workspaceId);
  }

  nextIssueNumber(workspaceId: string): number {
    const ws = this.repo.findById(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    const next = ws.issueCounter + 1;
    this.repo.update(workspaceId, { issueCounter: next });
    return next;
  }
}
