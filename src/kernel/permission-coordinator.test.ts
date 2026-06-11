/**
 * PermissionCoordinator 硬约束单测（§3.8 第二层 / B.3）。
 *
 * 覆盖：
 *   - checkActiveScope 无 scope 时不阻塞
 *   - checkActiveScope 命中 blockTools → 拒绝
 *   - checkActiveScope 命中 blockPaths → 拒绝（toolInput 含被禁路径）
 *   - checkAndIssue 入口先做 active_scope 拦截（fail-closed）
 *   - setActiveScope + clearActiveScope 生命周期
 *   - 没有 StateCache 时 setActiveScope 是 no-op
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PermissionEngine, PermissionCheckResult } from '../safety/contract.js';
import type { ApprovalManager } from '../safety/approval-manager.js';
import type { TokenIssuer } from '../safety/token-issuer.js';
import { StateCache } from './state-cache.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import type { DangerLevel } from '../utils/types.js';
import type { RiskLevel } from '../safety/index.js';

class MockEngine implements PermissionEngine {
  constructor(private readonly allow: boolean = true, private readonly requiresReview: boolean = false) {}
  checkPermission(): PermissionCheckResult {
    return { allowed: this.allow, requiresReview: this.requiresReview };
  }
}

class MockApprovalManager {
  createRequest = () => ({ id: 'req-mock', riskLevel: 'low' as RiskLevel });
  autoDecide = () => null;
}

class MockTokenIssuer {}

function makeCoordinator(stateCache: StateCache | null = new StateCache(), allow = true): PermissionCoordinator {
  const coordinator = new PermissionCoordinator({
    engine: new MockEngine(allow) as unknown as PermissionEngine,
    tokenIssuer: new MockTokenIssuer() as unknown as TokenIssuer,
    approvalManager: new MockApprovalManager() as unknown as ApprovalManager,
    stateCache: stateCache ?? undefined,
  });
  return coordinator;
}

describe('PermissionCoordinator.checkActiveScope（§3.8 第二层 / B.3）', () => {
  let cache: StateCache;
  let coordinator: PermissionCoordinator;

  beforeEach(() => {
    cache = new StateCache();
    coordinator = makeCoordinator(cache);
  });

  it('无 active_scope 时不阻塞', () => {
    const result = coordinator.checkActiveScope('task-1', 'read_file', '/some/path');
    expect(result).toBeNull();
  });

  it('taskId 为 undefined 时不阻塞', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    const result = coordinator.checkActiveScope(undefined, 'run_command', 'ls');
    expect(result).toBeNull();
  });

  it('命中 blockTools → 返回拒绝原因', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command', 'write_file'] });
    const result = coordinator.checkActiveScope('task-1', 'run_command', 'ls');
    expect(result).toContain('active_scope');
    expect(result).toContain('run_command');
  });

  it('未命中 blockTools → 不阻塞', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    const result = coordinator.checkActiveScope('task-1', 'read_file', '/tmp/foo');
    expect(result).toBeNull();
  });

  it('toolInput 含被禁路径 → 返回拒绝原因', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['/etc/passwd', '/root/.ssh'] });
    const result = coordinator.checkActiveScope('task-1', 'read_file', '{"path":"/etc/passwd"}');
    expect(result).toContain('active_scope');
    expect(result).toContain('/etc/passwd');
  });

  it('toolInput 不含被禁路径 → 不阻塞', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['/etc/passwd'] });
    const result = coordinator.checkActiveScope('task-1', 'read_file', '{"path":"/tmp/safe"}');
    expect(result).toBeNull();
  });

  it('同时设 blockTools + blockPaths → 任一命中即拒绝', () => {
    coordinator.setActiveScope('task-1', {
      blockTools: ['run_command'],
      blockPaths: ['/etc'],
    });
    expect(coordinator.checkActiveScope('task-1', 'read_file', '/etc/foo')).toContain('/etc');
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'ls')).toContain('run_command');
    expect(coordinator.checkActiveScope('task-1', 'read_file', '/tmp/ok')).toBeNull();
  });

  it('clearActiveScope 后不再阻塞', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'x')).not.toBeNull();
    coordinator.clearActiveScope('task-1');
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'x')).toBeNull();
  });

  it('clearActiveScope 不影响其他 task', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    coordinator.setActiveScope('task-2', { blockTools: ['write_file'] });
    coordinator.clearActiveScope('task-1');
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'x')).toBeNull();
    expect(coordinator.checkActiveScope('task-2', 'write_file', 'x')).not.toBeNull();
  });

  it('覆盖已有 scope：setActiveScope 第二次写入全替换', () => {
    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    coordinator.setActiveScope('task-1', { blockTools: ['write_file'] });
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'x')).toBeNull();
    expect(coordinator.checkActiveScope('task-1', 'write_file', 'x')).not.toBeNull();
  });
});

describe('PermissionCoordinator 没有 StateCache 时降级（fail-open）', () => {
  it('无 StateCache 时 setActiveScope 是 no-op，不崩', () => {
    const coordinator = makeCoordinator(null);
    expect(() => coordinator.setActiveScope('task-1', { blockTools: ['x'] })).not.toThrow();
    expect(() => coordinator.clearActiveScope('task-1')).not.toThrow();
    // checkActiveScope 应该返回 null（无 StateCache → 无法读 → 不拦截）
    expect(coordinator.checkActiveScope('task-1', 'x', 'y')).toBeNull();
  });
});

describe('PermissionCoordinator.checkAndIssue 集成 active_scope', () => {
  it('active_scope 拦截优先于 engine.checkPermission', () => {
    // 即使 engine 允许 + approval 自动通过，active_scope 也要拦截
    const cache = new StateCache();
    const coordinator = new PermissionCoordinator({
      engine: new MockEngine(true) as unknown as PermissionEngine,
      tokenIssuer: new MockTokenIssuer() as unknown as TokenIssuer,
      approvalManager: {
        createRequest: () => ({ id: 'req-1', riskLevel: 'low' as RiskLevel }),
        autoDecide: () => ({ id: 'tok-1' }),
      } as unknown as ApprovalManager,
      stateCache: cache,
    });

    coordinator.setActiveScope('task-1', { blockTools: ['run_command'] });
    const result = coordinator.checkAndIssue({
      agentName: 'code',
      sessionId: 'sess-1',
      toolName: 'run_command',
      toolInput: 'ls',
      dangerLevel: 'safe' as DangerLevel,
      taskId: 'task-1',
    });

    // 期望：被 active_scope 拦截（allowed=false + reason 含 active_scope）
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('active_scope');
  });
});

/**
 * 13.0 §3.8 精确路径匹配测试 — 验证修正旧版子串匹配的误判。
 *
 * 旧版 `inputStr.includes(blockPath)` 的问题：
 * - blockPath='src' 误命中 'src-old/abc'（子串匹配）
 * - blockPath='auth.ts' 误命中 'auth.ts.bak'（子串匹配）
 *
 * 新版：精确路径前缀 + glob，只命中真实的路径层级关系。
 */
describe('PermissionCoordinator.checkActiveScope 精确路径匹配（§3.8 修正版）', () => {
  let coordinator: PermissionCoordinator;
  let stateCache: StateCache;

  beforeEach(() => {
    stateCache = new StateCache();
    coordinator = new PermissionCoordinator({
      engine: new MockEngine() as any,
      tokenIssuer: { issue: (() => ({ id: 't-1' })) as any, validate: (() => ({ valid: true })) as any, consume: (() => true) as any } as any,
      approvalManager: { createRequest: () => ({ id: 'req-mock' }), autoDecide: () => null } as any,
      stateCache,
    });
  });

  it('目录前缀：blockPath="src" 命中 src/auth.ts 但不命中 src-old/auth.ts', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['src'] });
    // ✅ 应命中：src/auth.ts 以 src/ 开头
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"src/auth.ts"}')).toContain('src');
    // ❌ 不应命中：src-old/auth.ts 不以 src/ 开头
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"src-old/auth.ts"}')).toBeNull();
  });

  it('精确文件匹配：blockPath="auth.ts" 只命中同名文件', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['auth.ts'] });
    // ✅ 精确匹配
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"auth.ts"}')).toContain('auth.ts');
    // ❌ 不匹配 .bak 文件
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"auth.ts.bak"}')).toBeNull();
    // ❌ 不匹配含 auth.ts 的长路径（不是精确匹配也不是目录前缀）
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"new-auth.ts"}')).toBeNull();
  });

  it('glob 模式：blockPath="*.env" 匹配所有 .env 文件', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['*.env'] });
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":".env"}')).toContain('*.env');
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"production.env"}')).toContain('*.env');
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"src/config.json"}')).toBeNull();
  });

  it('glob 跨目录：blockPath="src/**" 匹配 src 下所有文件', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['src/**'] });
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"src/auth.ts"}')).toContain('src/**');
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"src/deep/nested/file.ts"}')).toContain('src/**');
    expect(coordinator.checkActiveScope('task-1', 'read_file', '{"path":"other/auth.ts"}')).toBeNull();
  });

  it('原始路径字符串（非 JSON）：以 / 开头的路径直接匹配', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['/etc'] });
    // 原始路径字符串 /etc/passwd → 目录前缀匹配
    expect(coordinator.checkActiveScope('task-1', 'read_file', '/etc/passwd')).toContain('/etc');
    // /tmp/ok 不命中
    expect(coordinator.checkActiveScope('task-1', 'read_file', '/tmp/ok')).toBeNull();
  });

  it('非路径字符串不误判：ls / x 等命令不触发 blockPaths', () => {
    coordinator.setActiveScope('task-1', { blockPaths: ['/etc'] });
    // 'ls' 不是路径 → 不误判
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'ls')).toBeNull();
    // 'x' 不是路径 → 不误判
    expect(coordinator.checkActiveScope('task-1', 'run_command', 'x')).toBeNull();
  });
});