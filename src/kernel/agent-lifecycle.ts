import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentManager } from './agent-manager.js';
import type { ModuleRegistry } from './module-system.js';
import type { EventBus } from './event-bus.js';
import { agentManifestSchema, type AgentManifest } from '../agents/manifest.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent-lifecycle');

export interface AgentMetaRow {
  id: string;
  name: string;
  version: string;
  description: string;
  agent_dir: string;
  source: string;
  kind: string;
  level: number;
  status: string;
  roles_json: string;
  task_types_json: string;
  task_count: number;
  success_count: number;
  failure_count: number;
  installed_at: number;
  upgraded_at: number | null;
  removed_at: number | null;
  updated_at: number;
}

export interface AgentDetailInfo extends AgentMetaRow {
  running: boolean;
  manifest: AgentManifest | null;
}

export interface InstallResult {
  name: string;
  status: string;
}

export interface UpgradeResult {
  fromVersion: string;
  toVersion: string;
}

export interface ReloadResult {
  discovered: string[];
  upgraded: string[];
}

export class AgentLifecycle {
  constructor(
    private registry: AgentRegistry,
    private manager: AgentManager,
    private moduleRegistry: ModuleRegistry,
    private eventBus: EventBus,
    private db: Database.Database,
  ) {}

  async install(agentDir: string): Promise<InstallResult> {
    const manifestPath = join(agentDir, 'agent.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`未找到 agent.json: ${manifestPath}`);
    }

    const manifest = this.loadAndValidateManifest(manifestPath);

    if (this.registry.has(manifest.name)) {
      throw new Error(`智能体已存在: ${manifest.name}`);
    }

    const entryPath = join(agentDir, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`未找到入口文件: ${entryPath}`);
    }

    const registered = this.registry.register(manifest, manifestPath);
    this.registerModule(manifest);

    const status = 'enabled';
    this.upsertMeta(manifest, agentDir, status);
    this.recordEvent(manifest.name, 'installed', { source: manifest.source });

    if (manifest.kind === 'resident') {
      this.manager.startAgent(manifest.name, registered.entryPath);
    }

    this.eventBus.emit('agent.installed', {
      name: manifest.name,
      source: manifest.source,
      version: manifest.version,
    });

    logger.info({ name: manifest.name }, `已安装智能体: ${manifest.name}`);
    return { name: manifest.name, status };
  }

  async remove(name: string, opts?: { force?: boolean }): Promise<void> {
    const check = this.registry.canUnregister(name);
    if (!check.ok) {
      throw new Error(check.reason!);
    }

    if (!opts?.force) {
      const pending = this.countPendingTasks(name);
      if (pending > 0) {
        throw new Error(`智能体 ${name} 有 ${pending} 个进行中的任务，使用 force 强制移除`);
      }
    }

    if (this.manager.isRunning(name)) {
      await this.manager.stopAgent(name);
    }

    this.registry.unregister(name);
    this.unregisterModule(name);

    const now = Date.now();
    this.db.prepare(
      `UPDATE agents_meta SET status = 'removed', removed_at = ?, updated_at = ? WHERE name = ?`,
    ).run(now, now, name);

    this.recordEvent(name, 'removed');
    this.eventBus.emit('agent.removed', { name });
    logger.info({ name }, `已移除智能体: ${name}`);
  }

  async upgrade(name: string): Promise<UpgradeResult> {
    const existing = this.registry.get(name);
    if (!existing) throw new Error(`智能体不存在: ${name}`);

    const manifestPath = existing.manifestPath;
    const newManifest = this.loadAndValidateManifest(manifestPath);
    const fromVersion = existing.manifest.version;
    const toVersion = newManifest.version;

    if (this.manager.isRunning(name)) {
      await this.manager.stopAgent(name);
    }

    this.registry.unregister(name);
    const registered = this.registry.register(newManifest, manifestPath);

    if (newManifest.kind === 'resident' || this.manager.isRunning(name)) {
      this.manager.startAgent(name, registered.entryPath);
    }

    const now = Date.now();
    this.db.prepare(
      `UPDATE agents_meta SET version = ?, description = ?, upgraded_at = ?, updated_at = ?, roles_json = ?, task_types_json = ? WHERE name = ?`,
    ).run(newManifest.version, newManifest.description, now, now, JSON.stringify(newManifest.roles), JSON.stringify(newManifest.taskTypes), name);

    this.recordEvent(name, 'upgraded', { from_version: fromVersion, to_version: toVersion });
    this.eventBus.emit('agent.upgraded', { name, fromVersion, toVersion });
    logger.info({ name, fromVersion, toVersion }, `已升级智能体: ${name} ${fromVersion} → ${toVersion}`);
    return { fromVersion, toVersion };
  }

  async enable(name: string): Promise<void> {
    if (!this.registry.has(name)) throw new Error(`智能体不存在: ${name}`);
    if (!this.registry.isDisabled(name)) return;

    this.registry.enable(name);

    const registered = this.registry.get(name)!;
    if (registered.manifest.kind === 'resident') {
      this.manager.startAgent(name, registered.entryPath);
    }

    const now = Date.now();
    this.db.prepare(`UPDATE agents_meta SET status = 'enabled', updated_at = ? WHERE name = ?`).run(now, name);
    this.recordEvent(name, 'enabled');
    this.eventBus.emit('agent.enabled', { name });
    logger.info({ name }, `已启用智能体: ${name}`);
  }

  async disable(name: string, reason?: string): Promise<void> {
    if (!this.registry.has(name)) throw new Error(`智能体不存在: ${name}`);

    const agent = this.registry.get(name)!;
    for (const role of agent.manifest.roles) {
      if (role === 'reviewer' || role === 'primary') {
        throw new Error(`智能体承担系统关键角色 ${role}，不可禁用`);
      }
    }

    this.registry.disable(name);

    if (this.manager.isRunning(name)) {
      await this.manager.stopAgent(name);
    }

    const now = Date.now();
    this.db.prepare(`UPDATE agents_meta SET status = 'disabled', updated_at = ? WHERE name = ?`).run(now, name);
    this.recordEvent(name, 'disabled', { reason });
    this.eventBus.emit('agent.disabled', { name, reason });
    logger.info({ name, reason }, `已禁用智能体: ${name}`);
  }

  async reload(userDir: string): Promise<ReloadResult> {
    const discovered: string[] = [];
    const upgraded: string[] = [];

    const newAgents = await this.registry.refresh(userDir);
    for (const agent of newAgents) {
      this.registerModule(agent.manifest);
      this.upsertMeta(agent.manifest, dirname(agent.manifestPath), 'enabled');
      this.recordEvent(agent.manifest.name, 'installed', { source: agent.manifest.source });
      this.eventBus.emit('agent.installed', {
        name: agent.manifest.name,
        source: agent.manifest.source,
        version: agent.manifest.version,
      });
      discovered.push(agent.manifest.name);
    }

    return { discovered, upgraded };
  }

  list(filters?: { source?: string; status?: string }): AgentMetaRow[] {
    let sql = `SELECT * FROM agents_meta WHERE 1=1`;
    const params: unknown[] = [];

    if (filters?.source) {
      sql += ` AND source = ?`;
      params.push(filters.source);
    }
    if (filters?.status) {
      sql += ` AND status = ?`;
      params.push(filters.status);
    }
    sql += ` ORDER BY name`;

    return this.db.prepare(sql).all(...params) as AgentMetaRow[];
  }

  inspect(name: string): AgentDetailInfo | null {
    const row = this.db.prepare(`SELECT * FROM agents_meta WHERE name = ?`).get(name) as AgentMetaRow | undefined;
    if (!row) return null;

    const registered = this.registry.get(name);
    return {
      ...row,
      running: this.manager.isRunning(name),
      manifest: registered?.manifest ?? null,
    };
  }

  seedBundledAgents(): void {
    for (const agent of this.registry.listAll()) {
      if (agent.manifest.source !== 'bundled') continue;
      const existing = this.db.prepare(`SELECT 1 FROM agents_meta WHERE name = ?`).get(agent.manifest.name);
      if (existing) continue;
      this.upsertMeta(agent.manifest, dirname(agent.manifestPath), 'enabled');
    }
  }

  private loadAndValidateManifest(manifestPath: string): AgentManifest {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return agentManifestSchema.parse(raw);
  }

  private upsertMeta(manifest: AgentManifest, agentDir: string, status: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agents_meta (
        id, name, version, description, agent_dir, source, kind, level,
        status, roles_json, task_types_json, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        description = excluded.description,
        agent_dir = excluded.agent_dir,
        status = excluded.status,
        roles_json = excluded.roles_json,
        task_types_json = excluded.task_types_json,
        updated_at = excluded.updated_at
    `).run(
      genId('agm'),
      manifest.name,
      manifest.version,
      manifest.description,
      agentDir,
      manifest.source,
      manifest.kind,
      manifest.level,
      status,
      JSON.stringify(manifest.roles),
      JSON.stringify(manifest.taskTypes),
      now,
      now,
    );
  }

  private recordEvent(agentName: string, eventType: string, payload?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO agent_lifecycle_events (id, agent_name, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(genId('ale'), agentName, eventType, JSON.stringify(payload ?? {}), Date.now());
  }

  private registerModule(manifest: AgentManifest): void {
    const moduleName = `${manifest.name}-agent`;
    if (this.moduleRegistry.get(moduleName)) return;

    const deps = ['agent-manager', 'llm'];
    if (manifest.kind === 'resident') {
      deps.push('memory', 'permissions');
    }
    this.moduleRegistry.register({
      name: moduleName,
      version: manifest.version,
      kind: 'agent',
      dependsOn: deps,
    });
  }

  private unregisterModule(name: string): void {
    const moduleName = `${name}-agent`;
    this.moduleRegistry.unregister(moduleName);
  }

  private countPendingTasks(agentName: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM agent_tasks WHERE target_agent = ? AND status NOT IN ('completed','failed','cancelled','timeout')`,
    ).get(agentName) as { cnt: number };
    return row.cnt;
  }
}
