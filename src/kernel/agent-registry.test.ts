/**
 * AgentRegistry §4.0 议会角色分配测试（①② 翻转锁定）。
 *
 * 钉死 16.0 议会拆分后的角色映射，防回归（谁改了 agent.json roles 让角色错位，本测试即红）：
 *   - 'permission' → ①permission agent
 *   - 'reviewer' → ②reviewer agent
 *   - 'orchestrator' → brain agent（③brain 降为纯协调者）
 *   - 'primary' → conversation agent（助手/user proxy）
 * + validateSystemRoles 通过（4 个系统必要角色都由 resident agent 承担）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AgentRegistry } from './agent-registry.js';

describe('AgentRegistry §4.0 议会角色分配（①② 翻转锁定）', () => {
  let userDir: string;

  afterEach(() => {
    if (userDir) rmSync(userDir, { recursive: true, force: true });
  });

  it('bundled agents 声明正确的议会角色（①permission/②reviewer/③brain=orchestrator/primary=conversation）', async () => {
    userDir = mkdtempSync(resolve(tmpdir(), 'berry-registry-roles-'));
    const registry = new AgentRegistry();
    await registry.discover({
      bundled: resolve('src/agents/bundled'),
      user: userDir,
    });

    // §4.0 议会四角色映射（①② 拆分后）
    expect(registry.requireRole('permission').manifest.name).toBe('permission');   // ①permission
    expect(registry.requireRole('reviewer').manifest.name).toBe('reviewer');         // ②reviewer
    expect(registry.requireRole('orchestrator').manifest.name).toBe('brain');        // ③brain（纯协调者）
    expect(registry.requireRole('primary').manifest.name).toBe('conversation');      // 助手/user proxy

    // 系统必要角色都由 resident agent 承担（reviewer/permission/primary/orchestrator）
    expect(() => registry.validateSystemRoles()).not.toThrow();
  });

  it('reviewer 与 permission 是独立 agent（非 brain 兼任）—— 议会拆分核心断言', async () => {
    userDir = mkdtempSync(resolve(tmpdir(), 'berry-registry-split-'));
    const registry = new AgentRegistry();
    await registry.discover({ bundled: resolve('src/agents/bundled'), user: userDir });

    const reviewer = registry.requireRole('reviewer').manifest.name;
    const permission = registry.requireRole('permission').manifest.name;
    const brain = registry.requireRole('orchestrator').manifest.name;

    // brain 不再兼任 reviewer / permission（议会拆分核心：三专员独立进程）
    expect(reviewer).not.toBe(brain);
    expect(permission).not.toBe(brain);
    expect(reviewer).not.toBe(permission);
  });
});
