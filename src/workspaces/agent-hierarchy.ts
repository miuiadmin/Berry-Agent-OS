import type Database from 'better-sqlite3';
import type { AgentHierarchyInfo, ReviewChainEntry } from '../contracts/org-tree.js';
import { reqStr, optStr } from '../db/row-helpers.js';

const MAX_CHAIN_DEPTH = 20;

export class AgentHierarchy {
  constructor(private readonly db: Database.Database) {}

  // 注：setSuperior / getSubordinates / getTopLevelAgent / assignToNode /
  // getAgentsBySubtree / validateNoCircularChain 已在 16.0 §17.8 删除
  // （superior_id 字段只读不写，这些方法零外部调用方）。
  // 保留的方法：getSuperior / getReviewChain / isTopLevel / getAgentsByNode（team-tools + workspace-router + superior-review-flow 活调用）

  getSuperior(agentId: string): AgentHierarchyInfo | null {
    const row = this.db.prepare(`
      SELECT s.* FROM workspace_agents s
      INNER JOIN workspace_agents a ON a.superior_id = s.id
      WHERE a.id = ? AND s.enabled = 1
    `).get(agentId) as Record<string, unknown> | undefined;
    return row ? this.rowToInfo(row) : null;
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

  getAgentsByNode(orgNodeId: string): AgentHierarchyInfo[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_agents WHERE org_node_id = ? AND enabled = 1
      ORDER BY role DESC, created_at ASC
    `).all(orgNodeId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToInfo(r));
  }

  private rowToInfo(row: Record<string, unknown>): AgentHierarchyInfo {
    return {
      agentId: reqStr(row, 'id'),
      agentName: reqStr(row, 'agent_name'),
      workspaceId: reqStr(row, 'workspace_id'),
      orgNodeId: optStr(row, 'org_node_id'),
      superiorId: optStr(row, 'superior_id'),
      role: reqStr(row, 'role') as 'lead' | 'member',
      description: optStr(row, 'description'),
    };
  }
}
