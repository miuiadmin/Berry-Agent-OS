import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { AgentRepository } from './agent.repository.js';
import type { Agent } from './agent.repository.js';

export type TrustLevel = 'probation' | 'standard' | 'trusted' | 'autonomous';

export interface CreateAgentInput {
  workspaceId?: string;
  orgNodeId?: string;
  superiorId?: string;
  userId: string;
  agentType?: 'global' | 'team';
  name: string;
  avatar?: string;
  roleDescription?: string;
  provider: string;
  config: Record<string, unknown>;
  thinkingLevel?: 'low' | 'medium' | 'high' | 'max';
  l2Capabilities?: string[];
  roles?: string[];
  workspacePath?: string;
}

export interface UpdateAgentInput {
  name?: string;
  avatar?: string;
  roleDescription?: string;
  config?: Record<string, unknown>;
  thinkingLevel?: string | null;
  customEnv?: Record<string, string>;
  customArgs?: string[];
  l2Capabilities?: string[];
  roles?: string[];
  status?: string;
}

const TRUST_THRESHOLDS = {
  probation: { approvalsToPromote: 5 },
  standard: { approvalsToPromote: 20 },
  trusted: { approvalsToPromote: 50 },
};

export class AgentService {
  constructor(
    private repo: AgentRepository,
    private events: AppEvents,
  ) {}

  create(input: CreateAgentInput): Agent {
    const id = genId();
    const now = new Date();
    const agent = {
      id,
      workspaceId: input.workspaceId ?? null,
      orgNodeId: input.orgNodeId ?? null,
      superiorId: input.superiorId ?? null,
      userId: input.userId,
      agentType: input.agentType ?? 'team',
      name: input.name,
      avatar: input.avatar ?? null,
      roleDescription: input.roleDescription ?? null,
      provider: input.provider,
      config: input.config as any,
      thinkingLevel: input.thinkingLevel ?? null,
      customEnv: null,
      customArgs: null,
      l2Capabilities: (input.l2Capabilities ?? ['learning', 'skills']) as any,
      roles: (input.roles ?? null) as any,
      workspacePath: input.workspacePath ?? null,
      status: 'idle',
      lastActiveAt: null,
      priorSessionId: null,
      priorWorkDir: null,
      archivedAt: null,
      archivedBy: null,
      trustLevel: 'probation',
      consecutiveApprovals: 0,
      totalRejections: 0,
      totalExecutions: 0,
      totalTokens: 0,
      successRate: null,
      createdAt: now,
    };
    this.repo.insert(agent);
    this.events.emit('agent.created', { agentId: id, workspaceId: input.workspaceId ?? null });
    return agent as Agent;
  }

  getById(id: string): Agent | undefined {
    return this.repo.findById(id);
  }

  listByWorkspace(workspaceId: string): Agent[] {
    return this.repo.findByWorkspace(workspaceId);
  }

  getGlobalAssistant(userId: string): Agent | undefined {
    return this.repo.findGlobalAssistant(userId);
  }

  getSubordinates(agentId: string): Agent[] {
    return this.repo.findBySuperior(agentId);
  }

  getSuperior(agentId: string): Agent | undefined {
    const agent = this.repo.findById(agentId);
    if (!agent?.superiorId) return undefined;
    return this.repo.findById(agent.superiorId);
  }

  update(id: string, input: UpdateAgentInput): void {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.avatar !== undefined) data.avatar = input.avatar;
    if (input.roleDescription !== undefined) data.roleDescription = input.roleDescription;
    if (input.config !== undefined) data.config = input.config;
    if (input.thinkingLevel !== undefined) data.thinkingLevel = input.thinkingLevel;
    if (input.customEnv !== undefined) data.customEnv = input.customEnv;
    if (input.customArgs !== undefined) data.customArgs = input.customArgs;
    if (input.l2Capabilities !== undefined) data.l2Capabilities = input.l2Capabilities;
    if (input.roles !== undefined) data.roles = input.roles;
    if (input.status !== undefined) data.status = input.status;

    this.repo.update(id, data as any);
    this.events.emit('agent.updated', { agentId: id });
  }

  setStatus(id: string, status: string): void {
    this.repo.update(id, { status, lastActiveAt: new Date() });
    this.events.emit('agent.status.changed', { agentId: id, status });
  }

  archive(id: string, archivedBy: string): void {
    this.repo.update(id, { archivedAt: new Date(), archivedBy, status: 'offline' });
    this.events.emit('agent.archived', { agentId: id });
  }

  recordApproval(agentId: string): void {
    const agent = this.repo.findById(agentId);
    if (!agent) return;

    const newCount = agent.consecutiveApprovals + 1;
    const updates: Record<string, unknown> = {
      consecutiveApprovals: newCount,
      totalExecutions: agent.totalExecutions + 1,
    };

    const threshold = TRUST_THRESHOLDS[agent.trustLevel as keyof typeof TRUST_THRESHOLDS];
    if (threshold && newCount >= threshold.approvalsToPromote) {
      const levels: TrustLevel[] = ['probation', 'standard', 'trusted', 'autonomous'];
      const currentIdx = levels.indexOf(agent.trustLevel as TrustLevel);
      if (currentIdx < levels.length - 1) {
        const newLevel = levels[currentIdx + 1];
        updates.trustLevel = newLevel;
        updates.consecutiveApprovals = 0;
        this.events.emit('agent.trust.changed', {
          agentId,
          oldLevel: agent.trustLevel,
          newLevel,
        });
      }
    }

    this.repo.update(agentId, updates as any);
  }

  recordRejection(agentId: string): void {
    const agent = this.repo.findById(agentId);
    if (!agent) return;

    this.repo.update(agentId, {
      consecutiveApprovals: 0,
      totalRejections: agent.totalRejections + 1,
      totalExecutions: agent.totalExecutions + 1,
    });
  }
}
