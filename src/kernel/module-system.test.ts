import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ModuleRegistry, createCoreModuleRegistry, registerAgentModules } from './module-system.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentManifest } from '../agents/manifest.js';
import { CORE_INDEX_SQL, CORE_SCHEMA_SQL } from '../memory/schema.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function createTestAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  const manifests: AgentManifest[] = [
    { apiVersion: 'berry.agent.v1', name: 'brain', version: '0.1.0', description: '审核', level: 1, kind: 'resident', source: 'bundled', taskTypes: ['brain_review'], roles: ['reviewer'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: false, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'conversation', version: '0.1.0', description: '对话', level: 3, kind: 'resident', source: 'bundled', taskTypes: ['conversation_turn'], roles: ['primary'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: true, dependencies: [], capabilities: {} },
  ];
  for (const m of manifests) {
    registry.register(m, `/fake/${m.name}/agent.json`);
  }
  return registry;
}

describe('ModuleRegistry', () => {
  it('按依赖输出拓扑启动顺序', () => {
    const registry = new ModuleRegistry();
    registry.register({ name: 'db', version: '1', kind: 'kernel' });
    registry.register({ name: 'memory', version: '1', kind: 'module', dependsOn: ['db'] });
    registry.register({ name: 'agent', version: '1', kind: 'agent', dependsOn: ['memory'] });

    expect(registry.dependencyOrder()).toEqual(['db', 'memory', 'agent']);
  });

  it('检测循环依赖', () => {
    const registry = new ModuleRegistry();
    registry.register({ name: 'a', version: '1', kind: 'module', dependsOn: ['b'] });
    registry.register({ name: 'b', version: '1', kind: 'module', dependsOn: ['a'] });

    expect(() => registry.dependencyOrder()).toThrow('模块依赖存在循环');
  });

  it('持久化 modules_meta 并输出 doctor 报告', () => {
    const db = createDb();
    const moduleRegistry = createCoreModuleRegistry();
    const agentRegistry = createTestAgentRegistry();
    registerAgentModules(agentRegistry, moduleRegistry);

    const report = moduleRegistry.doctor(db);

    expect(report.ok).toBe(true);
    expect(report.order).toContain('db');
    expect(report.modules.map((m) => m.name)).toContain('conversation-agent');

    const row = db.prepare(
      `SELECT version, kind, depends_on, status FROM modules_meta WHERE name = 'conversation-agent'`,
    ).get() as { version: string; kind: string; depends_on: string; status: string };

    expect(row.version).toBe('0.1.0');
    expect(row.kind).toBe('agent');
    expect(JSON.parse(row.depends_on)).toContain('memory');
    expect(row.status).toBe('registered');

    db.close();
  });

  it('更新模块健康状态', () => {
    const db = createDb();
    const registry = createCoreModuleRegistry();
    registry.persist(db);

    registry.markStatus(db, 'memory', 'failed', '初始化失败');

    const report = registry.doctor(db);
    const memory = report.modules.find((m) => m.name === 'memory');

    expect(report.ok).toBe(false);
    expect(memory?.status).toBe('failed');
    expect(memory?.lastError).toBe('初始化失败');

    db.close();
  });
});
