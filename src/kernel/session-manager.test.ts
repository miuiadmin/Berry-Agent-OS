import { describe, it, expect } from 'vitest';
import { SessionManager } from './session-manager.js';
import { MemoryRuntime } from '../memory/runtime.js';
import type { AppConfig } from '../config/schema.js';

/**
 * SessionManager GC 行为测试 —— 15.0 R2-4 D1 簇安全网。
 *
 * 钉死 runGc 回收过期 session 时调用 onSessionGc 回调（core-service 接线到
 * PermissionCoordinator.clearSessionMode），防止 per-session permission mode 无界增长。
 */
function makeSessionManager(onSessionGc?: (sid: string) => void): SessionManager {
  const memoryRuntime = new MemoryRuntime({} as AppConfig['memory']);
  return new SessionManager({
    memoryRuntime,
    skillLoader: null,
    evolutionEngine: null,
    // runGc 路径不读 config 字段，最小构造即可
    config: {} as AppConfig,
    onSessionGc,
  });
}

describe('SessionManager.runGc → onSessionGc 回调（15.0 R2-4 D1）', () => {
  it('GC 回收过期 session 时，对每个被回收的 session 触发 onSessionGc', () => {
    const cleared: string[] = [];
    const sm = makeSessionManager((sid) => cleared.push(sid));
    sm.touchSession('s-active-1');
    sm.touchSession('s-active-2');
    // maxInactiveMs=-1：now - lastActive = 0 > -1 → 全部过期（无 active pending 时被回收）
    const result = sm.runGc(-1);
    expect(result.cleaned).toBe(2);
    expect(cleared.sort()).toEqual(['s-active-1', 's-active-2']);
  });

  it('无 onSessionGc 回调时 runGc 仍正常工作（向后兼容）', () => {
    const sm = makeSessionManager(); // 不传 onSessionGc
    sm.touchSession('s1');
    const result = sm.runGc(-1);
    expect(result.cleaned).toBe(1);
  });

  it('未过期的 session 不被回收，回调不触发', () => {
    const cleared: string[] = [];
    const sm = makeSessionManager((sid) => cleared.push(sid));
    sm.touchSession('s1');
    // maxInactiveMs 极大值：刚 touch 的 session 未过期
    const result = sm.runGc(Number.MAX_SAFE_INTEGER);
    expect(result.cleaned).toBe(0);
    expect(cleared).toEqual([]);
  });
});
