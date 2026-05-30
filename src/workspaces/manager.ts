import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { Workspace, WorkspaceCapability, WorkspaceCapabilityType, WorkspaceStatus } from '../contracts/workspaces.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, RegisterCapabilityInput, WorkspaceOverlay } from './types.js';
import { genId } from '../utils/id.js';

export class WorkspaceManager {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus | null,
  ) {}

  create(input: CreateWorkspaceInput): Workspace {
    const id = genId('ws');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO workspaces (id, slug, name, workspace_dir, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.slug, input.name, input.workspaceDir, now, now);

    const workspace = this.get(id)!;
    this.eventBus?.emit('workspace.created', { workspaceId: id, slug: input.slug });
    return workspace;
  }

  get(id: string): Workspace | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkspace(row) : null;
  }

  getBySlug(slug: string): Workspace | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(slug) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkspace(row) : null;
  }

  getByDir(dir: string): Workspace | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE workspace_dir = ?`).get(dir) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkspace(row) : null;
  }

  list(filter?: { status?: WorkspaceStatus }): Workspace[] {
    let sql = 'SELECT * FROM workspaces';
    const params: unknown[] = [];
    if (filter?.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToWorkspace(r));
  }

  update(id: string, input: UpdateWorkspaceInput): Workspace | null {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }

    if (sets.length === 0) return this.get(id);

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    this.eventBus?.emit('workspace.updated', { workspaceId: id });
    return this.get(id);
  }

  registerCapability(input: RegisterCapabilityInput): WorkspaceCapability {
    const id = genId('wc');
    const now = Date.now();
    const configHash = input.configPath ? this.computeFileHash(input.configPath) : null;

    this.db.prepare(`
      INSERT INTO workspace_capabilities (id, workspace_id, capability_type, capability_id, enabled, config_path, config_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, input.workspaceId, input.capabilityType, input.capabilityId, input.configPath ?? null, configHash, now, now);

    return this.getCapability(id)!;
  }

  removeCapability(workspaceId: string, capabilityType: WorkspaceCapabilityType, capabilityId: string): void {
    this.db.prepare(`
      DELETE FROM workspace_capabilities WHERE workspace_id = ? AND capability_type = ? AND capability_id = ?
    `).run(workspaceId, capabilityType, capabilityId);
  }

  getCapability(id: string): WorkspaceCapability | null {
    const row = this.db.prepare(`SELECT * FROM workspace_capabilities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToCapability(row) : null;
  }

  getOverlay(workspaceId: string): WorkspaceOverlay {
    const rows = this.db.prepare(
      `SELECT * FROM workspace_capabilities WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at`,
    ).all(workspaceId) as Record<string, unknown>[];

    const caps = rows.map(r => this.rowToCapability(r));
    return {
      skills: caps.filter(c => c.capabilityType === 'skill'),
      plugins: caps.filter(c => c.capabilityType === 'plugin'),
      mcps: caps.filter(c => c.capabilityType === 'mcp'),
    };
  }

  listCapabilities(workspaceId: string): WorkspaceCapability[] {
    const rows = this.db.prepare(
      `SELECT * FROM workspace_capabilities WHERE workspace_id = ? ORDER BY created_at`,
    ).all(workspaceId) as Record<string, unknown>[];
    return rows.map(r => this.rowToCapability(r));
  }

  private computeFileHash(filePath: string): string | null {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private rowToWorkspace(row: Record<string, unknown>): Workspace {
    return {
      id: row.id as string,
      slug: row.slug as string,
      name: row.name as string,
      workspaceDir: row.workspace_dir as string,
      status: row.status as WorkspaceStatus,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToCapability(row: Record<string, unknown>): WorkspaceCapability {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      capabilityType: row.capability_type as WorkspaceCapabilityType,
      capabilityId: row.capability_id as string,
      enabled: Boolean(row.enabled),
      configPath: (row.config_path as string) ?? null,
      configHash: (row.config_hash as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
