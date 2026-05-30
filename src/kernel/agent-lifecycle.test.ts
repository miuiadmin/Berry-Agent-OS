import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { AgentLifecycle } from './agent-lifecycle.js';
import { AgentRegistry } from './agent-registry.js';
import { AgentManager } from './agent-manager.js';
import { ModuleRegistry } from './module-system.js';
import { EventBus } from './event-bus.js';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function makeMinimalManifest(name: string, overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'berry.agent.v1',
    name,
    version: '0.1.0',
    description: `Agent ${name}`,
    level: 2,
    kind: 'on-demand',
    taskTypes: [`${name}_task`],
    roles: [],
    entry: 'entry.ts',
    ...overrides,
  };
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  for (const sql of CORE_SCHEMA_SQL.split(';')) {
    const trimmed = sql.trim();
    if (trimmed) db.exec(trimmed + ';');
  }
  for (const sql of CORE_INDEX_SQL.split(';')) {
    const trimmed = sql.trim();
    if (trimmed) db.exec(trimmed + ';');
  }
  return db;
}

describe('AgentLifecycle', () => {
  let tempDir: string;
  let db: Database.Database;
  let registry: AgentRegistry;
  let manager: AgentManager;
  let moduleRegistry: ModuleRegistry;
  let eventBus: EventBus;
  let lifecycle: AgentLifecycle;
  let originalHome: string;

  beforeEach(() => {
    originalHome = getAppHome();
    tempDir = mkdtempSync(join(tmpdir(), 'berry-lifecycle-'));
    setAppHome(tempDir);

    db = setupDb();
    registry = new AgentRegistry();
    eventBus = new EventBus();
    moduleRegistry = new ModuleRegistry();
    moduleRegistry.register({ name: 'agent-manager', version: '0.1.0', kind: 'kernel' });
    moduleRegistry.register({ name: 'llm', version: '0.1.0', kind: 'module' });

    manager = new AgentManager({ heartbeatIntervalMs: 30000, heartbeatTimeoutMs: 60000 } as any, registry);
    lifecycle = new AgentLifecycle(registry, manager, moduleRegistry, eventBus, db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    setAppHome(originalHome);
  });

  it('install 注册并持久化 on-demand Agent', async () => {
    const agentDir = join(tempDir, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('test-agent', { source: 'user' })));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    const result = await lifecycle.install(agentDir);
    expect(result.name).toBe('test-agent');
    expect(result.status).toBe('enabled');
    expect(registry.has('test-agent')).toBe(true);

    const row = db.prepare('SELECT * FROM agents_meta WHERE name = ?').get('test-agent') as any;
    expect(row).toBeDefined();
    expect(row.status).toBe('enabled');
    expect(row.source).toBe('user');
  });

  it('install 重复安装抛出错误', async () => {
    const agentDir = join(tempDir, 'dup-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('dup-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    await expect(lifecycle.install(agentDir)).rejects.toThrow('智能体已存在');
  });

  it('install 发出 agent.installed 事件', async () => {
    const agentDir = join(tempDir, 'evt-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('evt-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    const events: unknown[] = [];
    eventBus.on('agent.installed', (data) => events.push(data));
    await lifecycle.install(agentDir);

    expect(events.length).toBe(1);
    expect((events[0] as any).name).toBe('evt-agent');
  });

  it('remove 移除 Agent 并更新 DB', async () => {
    const agentDir = join(tempDir, 'rm-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('rm-agent', { source: 'user' })));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    expect(registry.has('rm-agent')).toBe(true);

    await lifecycle.remove('rm-agent');
    expect(registry.has('rm-agent')).toBe(false);

    const row = db.prepare('SELECT status FROM agents_meta WHERE name = ?').get('rm-agent') as any;
    expect(row.status).toBe('removed');
  });

  it('remove 拒绝移除 bundled Agent', async () => {
    const agentDir = join(tempDir, 'bundled-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('bundled-agent', { source: 'bundled' })));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    await expect(lifecycle.remove('bundled-agent')).rejects.toThrow('内置智能体不可移除');
  });

  it('disable/enable 切换 Agent 状态', async () => {
    const agentDir = join(tempDir, 'toggle-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('toggle-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);

    await lifecycle.disable('toggle-agent', '测试禁用');
    expect(registry.isDisabled('toggle-agent')).toBe(true);
    const row1 = db.prepare('SELECT status FROM agents_meta WHERE name = ?').get('toggle-agent') as any;
    expect(row1.status).toBe('disabled');

    await lifecycle.enable('toggle-agent');
    expect(registry.isDisabled('toggle-agent')).toBe(false);
    const row2 = db.prepare('SELECT status FROM agents_meta WHERE name = ?').get('toggle-agent') as any;
    expect(row2.status).toBe('enabled');
  });

  it('disable 拒绝禁用承担关键角色的 Agent', async () => {
    const agentDir = join(tempDir, 'role-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(
      makeMinimalManifest('role-agent', { roles: ['reviewer'], kind: 'resident', level: 1 }),
    ));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    await expect(lifecycle.disable('role-agent')).rejects.toThrow('系统关键角色');
  });

  it('upgrade 更新版本并记录事件', async () => {
    const agentDir = join(tempDir, 'upg-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('upg-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);

    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('upg-agent', { version: '0.2.0' })));
    const result = await lifecycle.upgrade('upg-agent');
    expect(result.fromVersion).toBe('0.1.0');
    expect(result.toVersion).toBe('0.2.0');

    const event = db.prepare(
      `SELECT * FROM agent_lifecycle_events WHERE agent_name = ? AND event_type = 'upgraded'`,
    ).get('upg-agent') as any;
    expect(event).toBeDefined();
  });

  it('list 返回所有已注册 Agent', async () => {
    const dir1 = join(tempDir, 'a1');
    const dir2 = join(tempDir, 'a2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, 'agent.json'), JSON.stringify(makeMinimalManifest('a1', { source: 'user' })));
    writeFileSync(join(dir1, 'entry.ts'), '// stub');
    writeFileSync(join(dir2, 'agent.json'), JSON.stringify(makeMinimalManifest('a2', { source: 'bundled' })));
    writeFileSync(join(dir2, 'entry.ts'), '// stub');

    await lifecycle.install(dir1);
    await lifecycle.install(dir2);

    const all = lifecycle.list();
    expect(all.length).toBe(2);

    const userOnly = lifecycle.list({ source: 'user' });
    expect(userOnly.length).toBe(1);
    expect(userOnly[0].name).toBe('a1');
  });

  it('inspect 返回 Agent 详细信息', async () => {
    const agentDir = join(tempDir, 'detail-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('detail-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    const detail = lifecycle.inspect('detail-agent');
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('detail-agent');
    expect(detail!.running).toBe(false);
    expect(detail!.manifest).not.toBeNull();
  });

  it('inspect 对不存在的 Agent 返回 null', () => {
    expect(lifecycle.inspect('ghost')).toBeNull();
  });

  it('install 在模块系统中注册 Agent 模块', async () => {
    const agentDir = join(tempDir, 'mod-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('mod-agent')));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    expect(moduleRegistry.get('mod-agent-agent')).toBeDefined();
  });

  it('remove 从模块系统注销 Agent 模块', async () => {
    const agentDir = join(tempDir, 'unreg-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(makeMinimalManifest('unreg-agent', { source: 'user' })));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    await lifecycle.install(agentDir);
    expect(moduleRegistry.get('unreg-agent-agent')).toBeDefined();

    await lifecycle.remove('unreg-agent');
    expect(moduleRegistry.get('unreg-agent-agent')).toBeUndefined();
  });
});
