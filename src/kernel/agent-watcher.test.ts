import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentWatcher } from './agent-watcher.js';
import type { AgentLifecycle } from './agent-lifecycle.js';
import type { AgentRegistry } from './agent-registry.js';

function makeLifecycleMock() {
  return {
    install: vi.fn().mockResolvedValue({ name: 'test', status: 'enabled' }),
    remove: vi.fn().mockResolvedValue(undefined),
    upgrade: vi.fn().mockResolvedValue({ fromVersion: '0.1.0', toVersion: '0.2.0' }),
  } as unknown as AgentLifecycle;
}

function makeRegistryMock(registered: Set<string> = new Set()) {
  return {
    has: (name: string) => registered.has(name),
    canUnregister: (name: string) => registered.has(name) ? { ok: true } : { ok: false, reason: 'not found' },
  } as unknown as AgentRegistry;
}

describe('AgentWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'berry-watcher-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('watch 对不存在的目录不启动', () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock();
    const watcher = new AgentWatcher(lifecycle, registry);

    watcher.watch(join(tempDir, 'nonexistent'));
    watcher.dispose();
  });

  it('dispose 清理 watcher 和 timers', () => {
    mkdirSync(tempDir, { recursive: true });
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock();
    const watcher = new AgentWatcher(lifecycle, registry);

    watcher.watch(tempDir);
    watcher.dispose();
    // 不应抛错
    watcher.dispose();
  });

  it('检测新 agent.json 文件并触发 install', async () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock();
    const watcher = new AgentWatcher(lifecycle, registry);

    watcher.watch(tempDir);

    await new Promise(resolve => setTimeout(resolve, 100));

    const agentDir = join(tempDir, 'new-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), '{}');

    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(lifecycle.install).toHaveBeenCalledWith(agentDir);
    watcher.dispose();
  });

  it('检测已注册 agent 变更并触发 upgrade', async () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock(new Set(['existing-agent']));
    const watcher = new AgentWatcher(lifecycle, registry);

    const agentDir = join(tempDir, 'existing-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), '{}');

    watcher.watch(tempDir);

    await new Promise(resolve => setTimeout(resolve, 100));

    writeFileSync(join(agentDir, 'agent.json'), '{"version":"0.2.0"}');

    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(lifecycle.upgrade).toHaveBeenCalledWith('existing-agent');
    watcher.dispose();
  });

  it('检测目录删除并触发 remove', async () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock(new Set(['del-agent']));
    const watcher = new AgentWatcher(lifecycle, registry);

    const agentDir = join(tempDir, 'del-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), '{}');

    watcher.watch(tempDir);

    await new Promise(resolve => setTimeout(resolve, 100));

    rmSync(agentDir, { recursive: true, force: true });

    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(lifecycle.remove).toHaveBeenCalledWith('del-agent');
    watcher.dispose();
  });

  it('忽略非 agent.json 和非 .ts 文件变更', async () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock();
    const watcher = new AgentWatcher(lifecycle, registry);

    watcher.watch(tempDir);

    await new Promise(resolve => setTimeout(resolve, 100));

    const agentDir = join(tempDir, 'some-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'readme.md'), '# hi');

    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(lifecycle.install).not.toHaveBeenCalled();
    expect(lifecycle.upgrade).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('debounce 合并多次快速变更为一次操作', async () => {
    const lifecycle = makeLifecycleMock();
    const registry = makeRegistryMock(new Set(['rapid-agent']));
    const watcher = new AgentWatcher(lifecycle, registry);

    const agentDir = join(tempDir, 'rapid-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), '{}');

    watcher.watch(tempDir);

    await new Promise(resolve => setTimeout(resolve, 100));

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(agentDir, 'agent.json'), `{"v":${i}}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(lifecycle.upgrade).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });
});
