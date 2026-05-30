import type Database from 'better-sqlite3';
import type { ModuleKind } from '../contracts/agents.js';
import type { AgentRegistry } from './agent-registry.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';

const logger = getLogger('module-system');

export const MODULE_STATUSES = [
  'registered',
  'starting',
  'running',
  'stopped',
  'failed',
  'disabled',
] as const;

export type ModuleStatus = typeof MODULE_STATUSES[number];

export interface ModuleDefinition {
  name: string;
  version: string;
  kind: ModuleKind;
  contractVersion?: string;
  dependsOn?: string[];
}

export interface ModuleRecord extends ModuleDefinition {
  status: ModuleStatus;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface ModuleHealth {
  name: string;
  status: ModuleStatus;
  missingDependencies: string[];
  lastError: string | null;
}

export interface ModuleDoctorReport {
  ok: boolean;
  order: string[];
  modules: ModuleHealth[];
}

export class ModuleRegistry {
  private modules = new Map<string, ModuleDefinition>();

  register(definition: ModuleDefinition): void {
    if (!definition.name.trim()) {
      throw new Error('模块名称不能为空');
    }
    if (this.modules.has(definition.name)) {
      throw new Error(`模块已注册: ${definition.name}`);
    }
    this.modules.set(definition.name, {
      ...definition,
      dependsOn: definition.dependsOn ?? [],
    });
  }

  unregister(name: string): void {
    this.modules.delete(name);
  }

  get(name: string): ModuleDefinition | undefined {
    return this.modules.get(name);
  }

  list(): ModuleDefinition[] {
    return [...this.modules.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  dependencyOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (name: string, stack: string[]): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`模块依赖存在循环: ${[...stack, name].join(' -> ')}`);
      }
      const mod = this.modules.get(name);
      if (!mod) {
        throw new Error(`模块依赖不存在: ${name}`);
      }

      visiting.add(name);
      for (const dep of mod.dependsOn ?? []) {
        visit(dep, [...stack, name]);
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.modules.keys()) {
      visit(name, []);
    }
    return order;
  }

  persist(db: Database.Database): void {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO modules_meta (
        name, version, kind, status, contract_version, depends_on, updated_at
      ) VALUES (?, ?, ?, 'registered', ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        kind = excluded.kind,
        contract_version = excluded.contract_version,
        depends_on = excluded.depends_on,
        updated_at = excluded.updated_at
    `);

    const tx = db.transaction(() => {
      for (const mod of this.modules.values()) {
        stmt.run(
          mod.name,
          mod.version,
          mod.kind,
          mod.contractVersion ?? null,
          JSON.stringify(mod.dependsOn ?? []),
          now,
        );
      }
    });
    tx();
  }

  markStatus(db: Database.Database, name: string, status: ModuleStatus, error?: string): void {
    const now = Date.now();
    const startedAt = status === 'running' || status === 'starting' ? now : null;
    const stoppedAt = status === 'stopped' ? now : null;
    db.prepare(`
      UPDATE modules_meta
      SET status = ?,
          last_started_at = COALESCE(?, last_started_at),
          last_stopped_at = COALESCE(?, last_stopped_at),
          last_error = ?,
          updated_at = ?
      WHERE name = ?
    `).run(status, startedAt, stoppedAt, error ?? null, now, name);
  }

  doctor(db: Database.Database): ModuleDoctorReport {
    const order = this.dependencyOrder();
    this.persist(db);

    const rows = db.prepare(`
      SELECT name, status, depends_on, last_error
      FROM modules_meta
      ORDER BY name
    `).all() as Array<{
      name: string;
      status: ModuleStatus;
      depends_on: string;
      last_error: string | null;
    }>;

    const names = new Set(rows.map((row) => row.name));
    const modules = rows.map((row) => {
      const dependsOn = safeParseStringArray(row.depends_on);
      return {
        name: row.name,
        status: row.status,
        missingDependencies: dependsOn.filter((dep) => !names.has(dep)),
        lastError: row.last_error,
      };
    });

    return {
      ok: modules.every((mod) => mod.status !== 'failed' && mod.missingDependencies.length === 0),
      order,
      modules,
    };
  }
}

export function createCoreModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register({ name: 'config', version: '0.1.0', kind: 'kernel' });
  registry.register({ name: 'db', version: '0.1.0', kind: 'kernel', dependsOn: ['config'] });
  registry.register({ name: 'event-bus', version: '0.1.0', kind: 'kernel' });
  registry.register({ name: 'observability', version: '0.1.0', kind: 'module', dependsOn: ['config', 'db'] });
  registry.register({ name: 'memory', version: '0.1.0', kind: 'module', dependsOn: ['db'] });
  registry.register({ name: 'permissions', version: '0.1.0', kind: 'module', dependsOn: ['db'] });
  registry.register({ name: 'llm', version: '0.1.0', kind: 'module', dependsOn: ['config', 'db'] });
  registry.register({ name: 'agent-manager', version: '0.1.0', kind: 'kernel', dependsOn: ['config', 'db'] });
  registry.register({ name: 'plugins-v2', version: '0.1.0', kind: 'module', dependsOn: ['db', 'config'] });
  registry.register({ name: 'testing', version: '0.1.0', kind: 'testing', dependsOn: ['llm', 'db'] });
  return registry;
}

export function registerAgentModules(agentRegistry: AgentRegistry, moduleRegistry: ModuleRegistry): void {
  for (const agent of agentRegistry.listAll()) {
    const moduleName = `${agent.manifest.name}-agent`;
    if (moduleRegistry.get(moduleName)) continue;

    const deps = ['agent-manager', 'llm'];
    if (agent.manifest.kind === 'resident') {
      deps.push('memory', 'permissions');
    }

    moduleRegistry.register({
      name: moduleName,
      version: agent.manifest.version,
      kind: 'agent',
      dependsOn: deps,
    });
  }
}

export function makeModuleInstanceId(moduleName: string): string {
  return genId(`mod_${moduleName.replace(/[^a-zA-Z0-9]+/g, '_')}`);
}

function safeParseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (err) {
    logger.debug({ err, value }, 'JSON 字符串数组解析失败');
    return [];
  }
}
