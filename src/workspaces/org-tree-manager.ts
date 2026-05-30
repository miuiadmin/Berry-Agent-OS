import type Database from 'better-sqlite3';
import type { OrgNode, OrgNodeDefinition, BuildTeamInput, BuildTeamResult } from '../contracts/org-tree.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('org-tree-manager');

interface CreateNodeInput {
  workspaceId: string;
  parentId: string | null;
  name: string;
  description?: string;
  nodeType?: string;
  position?: number;
}

interface UpdateNodeInput {
  name?: string;
  description?: string;
  nodeType?: string;
  metadata?: Record<string, unknown>;
}

export class OrgTreeManager {
  constructor(private readonly db: Database.Database) {}

  createNode(input: CreateNodeInput): OrgNode {
    const id = genId('on');
    const now = Date.now();
    const nodeType = input.nodeType ?? 'group';

    let parentPath = '';
    let depth = 0;
    if (input.parentId) {
      const parent = this.getNode(input.parentId);
      if (!parent) throw new Error(`Parent node not found: ${input.parentId}`);
      parentPath = parent.path;
      depth = parent.depth + 1;
    }

    const path = parentPath ? `${parentPath}/${id}` : `/${id}`;
    const position = input.position ?? this.getNextPosition(input.parentId);

    this.db.prepare(`
      INSERT INTO org_nodes (id, workspace_id, parent_id, name, description, node_type, path, depth, position, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(id, input.workspaceId, input.parentId, input.name, input.description ?? null, nodeType, path, depth, position, now, now);

    logger.debug({ id, name: input.name, path }, 'Node created');
    return this.getNode(id)!;
  }

  getNode(id: string): OrgNode | null {
    const row = this.db.prepare('SELECT * FROM org_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  updateNode(id: string, input: UpdateNodeInput): OrgNode | null {
    const existing = this.getNode(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description); }
    if (input.nodeType !== undefined) { sets.push('node_type = ?'); params.push(input.nodeType); }
    if (input.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(input.metadata)); }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE org_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getNode(id);
  }

  deleteNode(id: string): { deleted: number } {
    const node = this.getNode(id);
    if (!node) return { deleted: 0 };

    const result = this.db.prepare(`DELETE FROM org_nodes WHERE path LIKE ? OR id = ?`).run(`${node.path}/%`, id);

    this.db.prepare(`UPDATE workspace_agents SET org_node_id = NULL WHERE org_node_id IN (
      SELECT id FROM org_nodes WHERE path LIKE ? OR id = ?
    )`).run(`${node.path}/%`, id);

    this.db.prepare(`UPDATE workspace_agents SET org_node_id = NULL WHERE org_node_id = ?`).run(id);

    logger.debug({ id, path: node.path, deleted: result.changes }, 'Node subtree deleted');
    return { deleted: result.changes };
  }

  getRootNode(workspaceId: string): OrgNode | null {
    const row = this.db.prepare(`
      SELECT * FROM org_nodes WHERE workspace_id = ? AND parent_id IS NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(workspaceId) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getChildren(parentId: string): OrgNode[] {
    const rows = this.db.prepare(`
      SELECT * FROM org_nodes WHERE parent_id = ? ORDER BY position ASC
    `).all(parentId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getSubtree(nodeId: string): OrgNode[] {
    const node = this.getNode(nodeId);
    if (!node) return [];
    const rows = this.db.prepare(`
      SELECT * FROM org_nodes WHERE path LIKE ? AND id != ? ORDER BY depth ASC, position ASC
    `).all(`${node.path}/%`, nodeId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getAncestors(nodeId: string): OrgNode[] {
    const node = this.getNode(nodeId);
    if (!node) return [];

    const segments = node.path.split('/').filter(Boolean);
    segments.pop();
    if (segments.length === 0) return [];

    const placeholders = segments.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM org_nodes WHERE id IN (${placeholders}) ORDER BY depth ASC
    `).all(...segments) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getFullTree(workspaceId: string): OrgNode[] {
    const rows = this.db.prepare(`
      SELECT * FROM org_nodes WHERE workspace_id = ? ORDER BY depth ASC, position ASC
    `).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  moveNode(nodeId: string, newParentId: string | null): void {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    let newParentPath = '';
    let newDepth = 0;
    if (newParentId) {
      const parent = this.getNode(newParentId);
      if (!parent) throw new Error(`New parent not found: ${newParentId}`);
      if (parent.path.startsWith(node.path)) {
        throw new Error('Cannot move node into its own subtree');
      }
      newParentPath = parent.path;
      newDepth = parent.depth + 1;
    }

    const oldPath = node.path;
    const newPath = newParentPath ? `${newParentPath}/${nodeId}` : `/${nodeId}`;
    const depthDelta = newDepth - node.depth;
    const position = this.getNextPosition(newParentId);

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE org_nodes SET path = replace(path, ?, ?), depth = depth + ?, updated_at = ?
        WHERE path LIKE ?
      `).run(oldPath, newPath, depthDelta, Date.now(), `${oldPath}/%`);

      this.db.prepare(`
        UPDATE org_nodes SET parent_id = ?, path = ?, depth = ?, position = ?, updated_at = ?
        WHERE id = ?
      `).run(newParentId, newPath, newDepth, position, Date.now(), nodeId);
    })();
  }

  reorderSiblings(parentId: string, orderedIds: string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE org_nodes SET position = ?, updated_at = ? WHERE id = ? AND parent_id IS ?');
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, now, orderedIds[i], parentId);
      }
    })();
  }

  buildTree(input: BuildTeamInput): BuildTeamResult {
    let nodesCreated = 0;
    let agentsCreated = 0;
    let leadAgent: string | null = null;

    const buildRecursive = (def: OrgNodeDefinition, parentId: string | null, parentPath: string, depth: number): string => {
      const id = genId('on');
      const now = Date.now();
      const nodeType = def.nodeType ?? 'group';
      const path = parentPath ? `${parentPath}/${id}` : `/${id}`;
      const position = this.getNextPosition(parentId);

      this.db.prepare(`
        INSERT INTO org_nodes (id, workspace_id, parent_id, name, description, node_type, path, depth, position, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
      `).run(id, input.workspaceId, parentId, def.name, def.description ?? null, nodeType, path, depth, position, now, now);
      nodesCreated++;

      if (def.agents) {
        for (const agent of def.agents) {
          const wsaId = genId('wsa');
          const role = agent.role ?? 'member';

          if (role === 'lead') {
            this.db.prepare(`
              UPDATE workspace_agents SET role = 'member'
              WHERE workspace_id = ? AND role = 'lead'
            `).run(input.workspaceId);
          }

          this.db.prepare(`
            INSERT INTO workspace_agents (id, workspace_id, agent_name, role, enabled, created_at, org_node_id, description)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(workspace_id, agent_name) DO UPDATE SET
              role = excluded.role, org_node_id = excluded.org_node_id, description = excluded.description, enabled = 1
          `).run(wsaId, input.workspaceId, agent.agentName, role, now, id, agent.description ?? null);
          agentsCreated++;

          if (role === 'lead') leadAgent = agent.agentName;
        }
      }

      if (def.children) {
        for (const child of def.children) {
          buildRecursive(child, id, path, depth + 1);
        }
      }

      return id;
    };

    const rootNodeId = this.db.transaction(() => {
      return buildRecursive(input.tree, null, '', 0);
    })();

    logger.info({ workspaceId: input.workspaceId, nodesCreated, agentsCreated }, 'Team built');
    return { rootNodeId, nodesCreated, agentsCreated, leadAgent };
  }

  private getNextPosition(parentId: string | null): number {
    const row = this.db.prepare(`
      SELECT MAX(position) as max_pos FROM org_nodes WHERE parent_id IS ?
    `).get(parentId) as { max_pos: number | null } | undefined;
    return (row?.max_pos ?? -1) + 1;
  }

  private rowToNode(row: Record<string, unknown>): OrgNode {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      parentId: (row.parent_id as string) ?? null,
      name: row.name as string,
      description: (row.description as string) ?? null,
      nodeType: row.node_type as string,
      path: row.path as string,
      depth: row.depth as number,
      position: row.position as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
