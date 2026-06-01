import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { safeJsonParse } from '../utils/safe-json.js';
import type { ITemplateService, TeamTemplateRow, CreateTemplateInput, TemplateCategory } from './contracts.js';

export class TemplateService implements ITemplateService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(`
        INSERT INTO team_templates (id, owner_id, name, description, category, org_structure, agent_configs, is_public, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      get: this.db.prepare(`SELECT * FROM team_templates WHERE id = ?`),
      list: this.db.prepare(`SELECT * FROM team_templates ORDER BY use_count DESC, updated_at DESC LIMIT ?`),
      listByCategory: this.db.prepare(`SELECT * FROM team_templates WHERE category = ? ORDER BY use_count DESC LIMIT ?`),
      listPublic: this.db.prepare(`SELECT * FROM team_templates WHERE is_public = 1 ORDER BY use_count DESC LIMIT ?`),
      listByCategoryPublic: this.db.prepare(`SELECT * FROM team_templates WHERE category = ? AND is_public = 1 ORDER BY use_count DESC LIMIT ?`),
      update: this.db.prepare(`UPDATE team_templates SET name = ?, description = ?, category = ?, org_structure = ?, agent_configs = ?, is_public = ?, updated_at = ? WHERE id = ?`),
      delete: this.db.prepare(`DELETE FROM team_templates WHERE id = ?`),
      incrementUse: this.db.prepare(`UPDATE team_templates SET use_count = use_count + 1, updated_at = ? WHERE id = ?`),

      getOrgNodes: this.db.prepare(`SELECT * FROM org_nodes WHERE workspace_id = ?`),
      getWorkspaceAgents: this.db.prepare(`SELECT * FROM workspace_agents WHERE workspace_id = ?`),
    };
  }

  create(input: CreateTemplateInput): TeamTemplateRow {
    const id = genId();
    const now = Date.now();
    const category = input.category ?? 'custom';
    const isPublic = input.isPublic ? 1 : 0;
    this.stmts.insert.run(id, input.ownerId, input.name, input.description ?? null, category, JSON.stringify(input.orgStructure), JSON.stringify(input.agentConfigs), isPublic, now, now);
    return {
      id, owner_id: input.ownerId, name: input.name, description: input.description ?? null,
      category, org_structure: JSON.stringify(input.orgStructure), agent_configs: JSON.stringify(input.agentConfigs),
      is_public: isPublic, use_count: 0, created_at: now, updated_at: now,
    };
  }

  get(id: string): TeamTemplateRow | null {
    return (this.stmts.get.get(id) as TeamTemplateRow) ?? null;
  }

  list(opts?: { category?: TemplateCategory; isPublic?: boolean; limit?: number }): TeamTemplateRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.category && opts?.isPublic) return this.stmts.listByCategoryPublic.all(opts.category, limit) as TeamTemplateRow[];
    if (opts?.category) return this.stmts.listByCategory.all(opts.category, limit) as TeamTemplateRow[];
    if (opts?.isPublic) return this.stmts.listPublic.all(limit) as TeamTemplateRow[];
    return this.stmts.list.all(limit) as TeamTemplateRow[];
  }

  update(id: string, updates: Partial<CreateTemplateInput>): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Template ${id} not found`);
    this.stmts.update.run(
      updates.name ?? existing.name,
      updates.description ?? existing.description,
      updates.category ?? existing.category,
      updates.orgStructure ? JSON.stringify(updates.orgStructure) : existing.org_structure,
      updates.agentConfigs ? JSON.stringify(updates.agentConfigs) : existing.agent_configs,
      updates.isPublic !== undefined ? (updates.isPublic ? 1 : 0) : existing.is_public,
      Date.now(),
      id,
    );
  }

  delete(id: string): void {
    this.stmts.delete.run(id);
  }

  saveFromWorkspace(workspaceId: string, name: string, ownerId: string, category?: TemplateCategory): TeamTemplateRow {
    const orgNodes = this.stmts.getOrgNodes.all(workspaceId);
    const agents = this.stmts.getWorkspaceAgents.all(workspaceId);
    return this.create({
      ownerId,
      name,
      category: category ?? 'custom',
      orgStructure: orgNodes,
      agentConfigs: agents,
    });
  }

  applyToWorkspace(templateId: string, workspaceId: string): void {
    const template = this.get(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const orgNodes = safeJsonParse<Array<Record<string, unknown>>>(template.org_structure, []);
    const agents = safeJsonParse<Array<Record<string, unknown>>>(template.agent_configs, []);
    const now = Date.now();

    const insertOrg = this.db.prepare(`
      INSERT OR IGNORE INTO org_nodes (id, workspace_id, name, description, parent_path, node_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAgent = this.db.prepare(`
      INSERT OR IGNORE INTO workspace_agents (id, workspace_id, agent_name, role, description, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `);

    const applyAll = this.db.transaction(() => {
      for (const node of orgNodes) {
        insertOrg.run(genId(), workspaceId, node.name, node.description ?? null, node.parent_path ?? '/', node.node_type ?? 'department', now);
      }
      for (const agent of agents) {
        insertAgent.run(genId(), workspaceId, agent.agent_name, agent.role ?? 'worker', agent.description ?? null, now);
      }
    });
    applyAll();
    this.incrementUseCount(templateId);
  }

  incrementUseCount(id: string): void {
    this.stmts.incrementUse.run(Date.now(), id);
  }
}
