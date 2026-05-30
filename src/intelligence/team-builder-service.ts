import { genId } from '../utils/id.js';
import type {
  ITeamBuilderService,
  TeamBuildPlan,
  TeamBuildSession,
  ApplyResult,
  ITemplateService,
} from './contracts.js';

interface LlmChatFn {
  (messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>): Promise<{ content: string }>;
}

interface WorkspaceCreator {
  createWorkspace(name: string, slug: string): string;
  createOrgNode(workspaceId: string, name: string, description: string, parentPath: string, nodeType: string): string;
  createWorkspaceAgent(workspaceId: string, agentName: string, role: string, description: string): string;
}

export class TeamBuilderService implements ITeamBuilderService {
  private sessions = new Map<string, TeamBuildSession>();

  constructor(
    private chatFn: LlmChatFn,
    private workspaceCreator: WorkspaceCreator | null,
    private templateService: ITemplateService | null,
  ) {}

  async startSession(userId: string, requirements: string): Promise<TeamBuildSession> {
    const id = genId();
    const session: TeamBuildSession = {
      id,
      userId,
      status: 'gathering',
      requirements,
      currentPlan: null,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    const plan = await this.generatePlan(requirements);
    session.currentPlan = plan;
    session.status = 'proposing';
    return session;
  }

  async refineSession(sessionId: string, feedback: string): Promise<TeamBuildSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.requirements += `\n\nRefinement: ${feedback}`;
    const plan = await this.generatePlan(session.requirements);
    session.currentPlan = plan;
    session.status = 'proposing';
    return session;
  }

  previewPlan(sessionId: string): TeamBuildPlan | null {
    const session = this.sessions.get(sessionId);
    return session?.currentPlan ?? null;
  }

  async approvePlan(sessionId: string): Promise<ApplyResult> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentPlan) throw new Error('No plan to approve');

    const plan = session.currentPlan;
    session.status = 'ready';

    if (!this.workspaceCreator) {
      throw new Error('Workspace creator not configured');
    }

    const workspaceId = this.workspaceCreator.createWorkspace(plan.workspaceName, plan.workspaceSlug);
    const orgNodeIds: string[] = [];
    const agentNames: string[] = [];

    for (const node of plan.orgNodes) {
      const nodeId = this.workspaceCreator.createOrgNode(
        workspaceId, node.name, node.description,
        node.parentPath ?? '/', node.nodeType ?? 'department',
      );
      orgNodeIds.push(nodeId);
    }

    for (const agent of plan.agents) {
      this.workspaceCreator.createWorkspaceAgent(
        workspaceId, agent.name, agent.role, agent.description,
      );
      agentNames.push(agent.name);
    }

    let templateId: string | undefined;
    if (this.templateService) {
      const template = this.templateService.saveFromWorkspace(workspaceId, plan.workspaceName, session.userId);
      templateId = template.id;
    }

    session.status = 'applied';
    return { workspaceId, agentNames, orgNodeIds, templateId };
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'cancelled';
    }
  }

  private async generatePlan(requirements: string): Promise<TeamBuildPlan> {
    const systemPrompt = `You are a team structure architect. Given requirements for a team/workspace, generate a JSON plan.
Output ONLY valid JSON matching this structure:
{
  "workspaceName": "string",
  "workspaceSlug": "string (kebab-case)",
  "orgNodes": [{"name": "string", "description": "string", "parentPath": "string", "nodeType": "department|team|role"}],
  "agents": [{"name": "string", "role": "leader|worker|specialist", "description": "string", "orgNodePath": "string"}],
  "defaultProject": {"name": "string", "description": "string"}
}`;

    const result = await this.chatFn(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: requirements },
      ],
      { agent: 'team-builder' },
    );

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      return JSON.parse(jsonMatch[0]) as TeamBuildPlan;
    } catch {
      return {
        workspaceName: 'New Team',
        workspaceSlug: 'new-team',
        orgNodes: [{ name: 'Engineering', description: 'Core team', parentPath: '/', nodeType: 'department' }],
        agents: [{ name: 'leader', role: 'leader', description: 'Team leader', orgNodePath: '/Engineering' }],
      };
    }
  }
}
