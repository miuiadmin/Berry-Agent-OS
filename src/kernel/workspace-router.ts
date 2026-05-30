import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { WorkspaceRouteDecision, GlobalRoutingResult } from '../contracts/routing.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { OrgTreeManager } from '../workspaces/org-tree-manager.js';
import type { AgentHierarchy } from '../workspaces/agent-hierarchy.js';
import type { FallbackRouter } from './fallback-router.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('workspace-router');

export type WorkspaceAgentRole = 'lead' | 'member';

export interface WorkspaceAgentBinding {
  id: string;
  workspaceId: string;
  agentName: string;
  role: WorkspaceAgentRole;
  enabled: boolean;
  createdAt: number;
}

export class WorkspaceRouter {
  private orgTreeManager: OrgTreeManager | null = null;
  private agentHierarchy: AgentHierarchy | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceManager: WorkspaceManager,
    private readonly fallbackRouter: FallbackRouter,
  ) {}

  getTeamLead(workspaceId: string): string | null {
    const row = this.db.prepare(`
      SELECT agent_name FROM workspace_agents
      WHERE workspace_id = ? AND role = 'lead' AND enabled = 1
      LIMIT 1
    `).get(workspaceId) as { agent_name: string } | undefined;
    return row?.agent_name ?? null;
  }

  getMembers(workspaceId: string): WorkspaceAgentBinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_agents
      WHERE workspace_id = ? AND enabled = 1
      ORDER BY role DESC, created_at ASC
    `).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(this.rowToBinding);
  }

  bindAgent(workspaceId: string, agentName: string, role: WorkspaceAgentRole): void {
    const id = genId('wsa');
    const now = Date.now();

    if (role === 'lead') {
      this.db.prepare(`
        UPDATE workspace_agents SET role = 'member'
        WHERE workspace_id = ? AND role = 'lead'
      `).run(workspaceId);
    }

    this.db.prepare(`
      INSERT INTO workspace_agents (id, workspace_id, agent_name, role, enabled, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(workspace_id, agent_name) DO UPDATE SET
        role = excluded.role,
        enabled = 1
    `).run(id, workspaceId, agentName, role, now);

    logger.info({ workspaceId, agentName, role }, '绑定 agent 到工作区');
  }

  unbindAgent(workspaceId: string, agentName: string): void {
    this.db.prepare(`
      UPDATE workspace_agents SET enabled = 0
      WHERE workspace_id = ? AND agent_name = ?
    `).run(workspaceId, agentName);
  }

  fallbackRoute(userMessage: string): WorkspaceRouteDecision | null {
    const hash = this.hashMessage(userMessage);
    const historyMatch = this.matchByHistory(hash);
    if (historyMatch) return historyMatch;

    const workspaces = this.workspaceManager.list({ status: 'active' });
    if (workspaces.length === 0) return null;

    const normalized = userMessage.toLowerCase();
    for (const ws of workspaces) {
      const nameTokens = ws.name.toLowerCase().split(/\s+/);
      if (nameTokens.some(t => t.length > 2 && normalized.includes(t))) {
        const lead = this.getTeamLead(ws.id);
        return {
          targetWorkspaceId: ws.id,
          targetAgent: lead ?? undefined,
          intent: 'keyword_match',
          confidence: 0.5,
        };
      }
    }

    return null;
  }

  recordSuccess(userMessage: string, workspaceId: string, intent?: string): void {
    const hash = this.hashMessage(userMessage);
    const id = genId('dh');
    this.db.prepare(`
      INSERT INTO delegation_history (id, user_message_hash, workspace_id, intent, success, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(id, hash, workspaceId, intent ?? null, Date.now());
  }

  recordFailure(userMessage: string, workspaceId: string, intent?: string): void {
    const hash = this.hashMessage(userMessage);
    const id = genId('dh');
    this.db.prepare(`
      INSERT INTO delegation_history (id, user_message_hash, workspace_id, intent, success, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(id, hash, workspaceId, intent ?? null, Date.now());
  }

  buildAskUserResult(): GlobalRoutingResult {
    const workspaces = this.workspaceManager.list({ status: 'active' });
    return {
      type: 'ask_user',
      question: '请选择要委托的工作区：',
      options: workspaces.map(ws => `${ws.name} (${ws.slug})`),
    };
  }

  listBindings(workspaceId: string): WorkspaceAgentBinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_agents WHERE workspace_id = ?
      ORDER BY role DESC, created_at ASC
    `).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(this.rowToBinding);
  }

  setOrgTree(mgr: OrgTreeManager, hierarchy: AgentHierarchy): void {
    this.orgTreeManager = mgr;
    this.agentHierarchy = hierarchy;
  }

  getReviewTarget(workspaceId: string, agentName: string): string | null {
    if (!this.agentHierarchy) return null;
    const binding = this.db.prepare(`
      SELECT id FROM workspace_agents
      WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1
    `).get(workspaceId, agentName) as { id: string } | undefined;
    if (!binding) return null;

    const superior = this.agentHierarchy.getSuperior(binding.id);
    return superior?.agentName ?? null;
  }

  isTopLevelAgent(workspaceId: string, agentName: string): boolean {
    if (!this.agentHierarchy) return true;
    const binding = this.db.prepare(`
      SELECT id FROM workspace_agents
      WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1
    `).get(workspaceId, agentName) as { id: string } | undefined;
    if (!binding) return true;

    return this.agentHierarchy.isTopLevel(binding.id);
  }

  private matchByHistory(hash: string): WorkspaceRouteDecision | null {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT workspace_id, intent, success,
             COUNT(*) as cnt
      FROM delegation_history
      WHERE user_message_hash = ? AND created_at > ?
      GROUP BY workspace_id, success
    `).all(hash, thirtyDaysAgo) as Array<{
      workspace_id: string;
      intent: string | null;
      success: number;
      cnt: number;
    }>;

    if (rows.length === 0) return null;

    let totalSuccess = 0;
    let totalFail = 0;
    let bestWorkspace: string | null = null;
    let bestCount = 0;
    let bestIntent: string | null = null;

    for (const row of rows) {
      if (row.success === 1) {
        totalSuccess += row.cnt;
        if (row.cnt > bestCount) {
          bestCount = row.cnt;
          bestWorkspace = row.workspace_id;
          bestIntent = row.intent;
        }
      } else {
        totalFail += row.cnt;
      }
    }

    const total = totalSuccess + totalFail;
    if (total < 2 || !bestWorkspace) return null;

    const successRate = totalSuccess / total;
    if (successRate < 0.8) return null;

    const lead = this.getTeamLead(bestWorkspace);
    logger.debug({ hash, workspaceId: bestWorkspace, successRate }, '历史匹配命中');

    return {
      targetWorkspaceId: bestWorkspace,
      targetAgent: lead ?? undefined,
      intent: bestIntent ?? 'history_match',
      confidence: Math.min(0.9, successRate),
    };
  }

  private hashMessage(message: string): string {
    const normalized = message.trim().toLowerCase().slice(0, 200);
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private rowToBinding(row: Record<string, unknown>): WorkspaceAgentBinding {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      agentName: row.agent_name as string,
      role: row.role as WorkspaceAgentRole,
      enabled: row.enabled === 1,
      createdAt: row.created_at as number,
    };
  }
}
