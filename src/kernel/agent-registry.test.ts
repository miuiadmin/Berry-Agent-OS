import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from './agent-registry.js';
import type { AgentManifest } from '../agents/manifest.js';
import { getAppHome, setAppHome } from '../utils/paths.js';

function makeManifest(overrides: Partial<AgentManifest> & { name: string }): AgentManifest {
  return {
    apiVersion: 'berry.agent.v1',
    version: '0.1.0',
    description: `Agent ${overrides.name}`,
    level: 2,
    kind: 'on-demand',
    source: 'bundled',
    taskTypes: [`${overrides.name}_task`],
    roles: [],
    entry: 'entry.ts',
    ipcProtocol: 'module-agent',
    requiresBrainReview: false,
    dependencies: [],
    capabilities: {},
    ...overrides,
  };
}

describe('AgentRegistry', () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(() => {
    originalHome = getAppHome();
    tempDir = mkdtempSync(join(tmpdir(), 'berry-registry-'));
    setAppHome(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    setAppHome(originalHome);
  });

  it('注册并查找 Agent', () => {
    const registry = new AgentRegistry();
    const manifest = makeManifest({ name: 'test-agent', taskTypes: ['test_task'] });
    registry.register(manifest, '/fake/test-agent/agent.json');

    expect(registry.has('test-agent')).toBe(true);
    expect(registry.get('test-agent')?.manifest.name).toBe('test-agent');
    expect(registry.getAgentNames()).toContain('test-agent');
  });

  it('按 taskType 索引查找', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'worker', taskTypes: ['build_task', 'deploy_task'] }),
      '/fake/worker/agent.json',
    );

    expect(registry.getByTaskType('build_task')?.manifest.name).toBe('worker');
    expect(registry.getByTaskType('deploy_task')?.manifest.name).toBe('worker');
    expect(registry.getByTaskType('unknown')).toBeUndefined();
  });

  it('按角色索引查找', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'my-brain', kind: 'resident', level: 1, taskTypes: ['review'], roles: ['reviewer'] }),
      '/fake/my-brain/agent.json',
    );

    expect(registry.getByRole('reviewer')?.manifest.name).toBe('my-brain');
    expect(registry.requireRole('reviewer').manifest.name).toBe('my-brain');
  });

  it('requireRole 在缺失角色时抛错', () => {
    const registry = new AgentRegistry();
    expect(() => registry.requireRole('reviewer')).toThrow('系统缺少必要角色 reviewer');
  });

  it('检测名称冲突', () => {
    const registry = new AgentRegistry();
    registry.register(makeManifest({ name: 'agent-a' }), '/fake/a/agent.json');
    expect(() => registry.register(makeManifest({ name: 'agent-a' }), '/fake/b/agent.json'))
      .toThrow('智能体名称冲突: agent-a 已注册');
  });

  it('分类 resident 和 on-demand', () => {
    const registry = new AgentRegistry();
    registry.register(makeManifest({ name: 'res', kind: 'resident', taskTypes: ['r'] }), '/fake/res/agent.json');
    registry.register(makeManifest({ name: 'od', kind: 'on-demand', taskTypes: ['o'] }), '/fake/od/agent.json');

    expect(registry.listResident().map(a => a.manifest.name)).toEqual(['res']);
    expect(registry.listOnDemand().map(a => a.manifest.name)).toEqual(['od']);
  });

  it('validateSystemRoles 通过正常配置', () => {
    const registry = new AgentRegistry();
    registry.register(makeManifest({ name: 'brain', kind: 'resident', level: 1, taskTypes: ['review'], roles: ['reviewer', 'orchestrator'] }), '/f/brain/agent.json');
    registry.register(makeManifest({ name: 'conv', kind: 'resident', level: 3, taskTypes: ['chat'], roles: ['primary'] }), '/f/conv/agent.json');

    expect(() => registry.validateSystemRoles()).not.toThrow();
  });

  it('validateSystemRoles 拒绝缺失角色', () => {
    const registry = new AgentRegistry();
    registry.register(makeManifest({ name: 'brain', kind: 'resident', level: 1, taskTypes: ['review'], roles: ['reviewer'] }), '/f/brain/agent.json');

    expect(() => registry.validateSystemRoles()).toThrow('缺少必要角色 "primary"');
  });

  it('validateSystemRoles 拒绝 on-demand 承担核心角色', () => {
    const registry = new AgentRegistry();
    registry.register(makeManifest({ name: 'brain', kind: 'resident', level: 1, taskTypes: ['review'], roles: ['reviewer'] }), '/f/brain/agent.json');
    registry.register(makeManifest({ name: 'conv', kind: 'on-demand', level: 3, taskTypes: ['chat'], roles: ['primary'] }), '/f/conv/agent.json');

    expect(() => registry.validateSystemRoles()).toThrow('必须由 resident Agent 承担');
  });

  it('从目录发现 Agent', async () => {
    const bundledDir = join(tempDir, 'bundled');
    const agentDir = join(bundledDir, 'echo');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify({
      apiVersion: 'berry.agent.v1',
      name: 'echo',
      description: 'Echo agent',
      level: 2,
      kind: 'on-demand',
      taskTypes: ['echo_task'],
    }));
    writeFileSync(join(agentDir, 'entry.ts'), '// stub');

    const registry = new AgentRegistry();
    await registry.discover({ bundled: bundledDir, user: join(tempDir, 'user-agents') });

    expect(registry.has('echo')).toBe(true);
    expect(registry.getByTaskType('echo_task')?.manifest.name).toBe('echo');
  });

  it('refresh 发现新增用户 Agent', async () => {
    const userDir = join(tempDir, 'user-agents');
    const registry = new AgentRegistry();
    await registry.discover({ bundled: join(tempDir, 'empty-bundled'), user: userDir });
    expect(registry.listAll().length).toBe(0);

    mkdirSync(join(userDir, 'custom'), { recursive: true });
    writeFileSync(join(userDir, 'custom', 'agent.json'), JSON.stringify({
      apiVersion: 'berry.agent.v1',
      name: 'custom',
      description: 'Custom agent',
      level: 2,
      kind: 'on-demand',
      taskTypes: ['custom_task'],
    }));

    const newAgents = await registry.refresh(userDir);
    expect(newAgents.length).toBe(1);
    expect(newAgents[0].manifest.name).toBe('custom');
    expect(registry.has('custom')).toBe(true);
  });

  it('unregister 清除 Agent 及索引', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'removable', taskTypes: ['rm_task'], roles: ['specialist'] as any }),
      '/fake/removable/agent.json',
    );

    expect(registry.has('removable')).toBe(true);
    expect(registry.getByTaskType('rm_task')).toBeDefined();

    registry.unregister('removable');
    expect(registry.has('removable')).toBe(false);
    expect(registry.getByTaskType('rm_task')).toBeUndefined();
  });

  it('canUnregister 拒绝 bundled Agent', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'built-in', source: 'bundled', taskTypes: ['bi_task'] }),
      '/fake/built-in/agent.json',
    );

    const check = registry.canUnregister('built-in');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('内置智能体不可移除');
  });

  it('canUnregister 拒绝关键角色 Agent', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'brain', source: 'user', kind: 'resident', level: 1, taskTypes: ['review'], roles: ['reviewer'] }),
      '/fake/brain/agent.json',
    );

    const check = registry.canUnregister('brain');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('系统关键角色');
  });

  it('canUnregister 允许普通用户 Agent', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'helper', source: 'user', taskTypes: ['help_task'] }),
      '/fake/helper/agent.json',
    );

    const check = registry.canUnregister('helper');
    expect(check.ok).toBe(true);
  });

  it('disable/enable 影响路由查找', () => {
    const registry = new AgentRegistry();
    registry.register(
      makeManifest({ name: 'worker', taskTypes: ['work_task'], roles: ['specialist'] as any }),
      '/fake/worker/agent.json',
    );

    expect(registry.getByTaskType('work_task')).toBeDefined();

    registry.disable('worker');
    expect(registry.isDisabled('worker')).toBe(true);
    expect(registry.getByTaskType('work_task')).toBeUndefined();

    registry.enable('worker');
    expect(registry.isDisabled('worker')).toBe(false);
    expect(registry.getByTaskType('work_task')).toBeDefined();
  });
});
