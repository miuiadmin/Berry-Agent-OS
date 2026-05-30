import type Database from 'better-sqlite3';
import type { AgentHierarchyInfo, ReviewChainEntry } from '../contracts/org-tree.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent-hierarchy');

const MAX_CHAIN_DEPTH = 20;

export class AgentHierarchy {
  constructor(private readonly db: Database.Database) {}

  setSuperior(agentId: string, superiorId: string | null): void {
    if (superiorId && !this.validateNoCircularChain(agentId, superiorId)) {
      throw new Error('Circular chain detected');
    }
    this.db.prepare('UPDATE workspace_agents SET superior_id = ? WHERE id = ?').run(superiorId, agentId);
    logger.debug({ agentId, superiorId }, 'Superior set');
  }

  getSuperior(agentId: string): AgentHierarchyInfo | null {
    const row = this.db.prepare(`
      SELECT s.* FROM workspace_agents s
      INNER JOIN workspace_agents a ON a.superior_id = s.id
      WHERE a.id = ? AND s.enabled = 1
    `).get(agentId) as Record<string, unknown> | undefined;
    return row ? this.rowToInfo(row) : null;
  }

  getSubordinates(agentId: string): AgentHierarchyInfo[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_agents WHERE superior_id = ? AND enabled = 1
      ORDER BY created_at ASC
    `).all(agentId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToInfo(r));
  }

  getReviewChain(agentId: string): ReviewChainEntry[] {
    const chain: ReviewChainEntry[] = [];
    let currentId: string | null = agentId;
    const seen = new Set<string>();

    while (currentId && chain.length < MAX_CHAIN_DEPTH) {
      const row = this.db.prepare(`
        SELECT s.id, s.agent_name, s.superior_id FROM workspace_agents s
        INNER JOIN workspace_agents a ON a.superior_id = s.id
        WHERE a.id = ? AND s.enabled = 1
      `).get(currentId) as { id: string; agent_name: string; superior_id: string | null } | undefined;

      if (!row) break;
      if (seen.has(row.id)) break;
      seen.add(row.id);

      chain.push({ agentId: row.id, agentName: row.agent_name, depth: chain.length });
      currentId = row.id;
    }

    return chain;
  }

  isTopLevel(agentId: string): boolean {
    const row = this.db.prepare('SELECT superior_id FROM workspace_agents WHERE id = ?').get(agentId) as { superior_id: string | null } | undefined;
    return row ? row.superior_id === null : true;
  }

  getTopLevelAgent(workspaceId: string): AgentHierarchyInfo | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_agents
      WHERE workspace_id = ? AND role = 'lead' AND superior_id IS NULL AND enabled = 1
      LIMIT 1
    `).get(workspaceId) as Record<string, unknown> | undefined;
    return row ? this.rowToInfo(row) : null;
  }

  assignToNode(agentId: string, orgNodeId: string): void {
    this.db.prepare('UPDATE workspace_agents SET org_node_id = ? WHERE id = ?').run(orgNodeId, agentId);
  }

  getAgentsByNode(orgNodeId: string): AgentHierarchyInfo[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_agents WHERE org_node_id = ? AND enabled = 1
      ORDER BY role DESC, created_at ASC
    `).all(orgNodeId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToInfo(r));
  }

  getAgentsBySubtree(orgNodeId: string): AgentHierarchyInfo[] {
    const rows = this.db.prepare(`
      SELECT wa.* FROM workspace_agents wa
      INNER JOIN org_nodes n ON wa.org_node_id = n.id
      WHERE n.path LIKE (SELECT path || '%' FROM org_nodes WHERE id = ?)
        AND wa.enabled = 1
      ORDER BY n.depth ASC, wa.role DESC
    `).all(orgNodeId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToInfo(r));
  }

  validateNoCircularChain(agentId: string, proposedSuperiorId: string): boolean {
    if (agentId === proposedSuperiorId) return false;

    let currentId: string | null = proposedSuperiorId;
    const seen = new Set<string>([agentId]);

    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
      if (!currentId) return true;
      if (seen.has(currentId)) return false;
      seen.add(currentId);

      const row = this.db.prepare('SELECT superior_id FROM workspace_agents WHERE id = ?').get(currentId) as { superior_id: string | null } | undefined;
      currentId = row?.superior_id ?? null;
    }

    return true;
  }

  private rowToInfo(row: Record<string, unknown>): AgentHierarchyInfo {
    return {
      agentId: row.id as string,
      agentName: row.agent_name as string,
      workspaceId: row.workspace_id as string,
      orgNodeId: (row.org_node_id as string) ?? null,
      superiorId: (row.superior_id as string) ?? null,
      role: row.role as 'lead' | 'member',
      description: (row.description as string) ?? null,
    };
  }
}
