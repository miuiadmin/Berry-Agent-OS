/**
 * V-2 active_scope 清理回归测试（16.0 P5 安全前置）。
 *
 * 钉死 delegation 终态化 → onTermination → permissionCoordinator.clearActiveScope 链路
 * （mission-subscriptions 订阅 delegation.completed/failed）。这是 V-2 修过的 active_scope
 * 跨 task 泄漏防御——P5 权威切换（delegation-manager 停 emit、board 派生 delegation.*）必须
 * 不破坏此清理。本测试是安全权威切换的回归守护：切换后若 board 派生漏触发 onTermination，
 * active_scope 不清 → 本测试红。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../../memory/db.js';
import { initEventBus, getEventBus } from '../event-bus.js';
import { TaskManager } from '../task-manager.js';
import { DelegationManager } from '../delegation-manager.js';
import { setupMissionSubscriptions } from './mission-subscriptions.js';
import type { PermissionCoordinator } from '../permission-coordinator.js';

describe('V-2 active_scope 清理回归（delegation 终态 → onTermination → clearActiveScope）', () => {
  let dir: string;
  let dm: DelegationManager;

  /** 构造 delegated 初态的 delegation（同 delegation-manager.test 模式） */
  function makeDelegation(): string {
    dir = mkdtempSync(join(tmpdir(), 'berry-v2-'));
    initDb(join(dir, 'test.db'));
    initEventBus();
    const tm = new TaskManager(getDb(), getEventBus());
    dm = new DelegationManager(tm);
    return dm.create({
      sessionId: 's1', correlationId: 'c1', taskType: 'delegation',
      requester: 'brain', targetAgent: 'code', targetKind: 'internal',
      foreground: false, inputPayload: { taskType: 'code_task' },
    });
  }

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 挂 mission 订阅（含 onTermination）+ 注入 clearActiveScope spy 的 mock permissionCoordinator */
  function setupWithSpy(): { clearSpy: ReturnType<typeof vi.fn> } {
    const clearSpy = vi.fn();
    const pc = { clearActiveScope: clearSpy } as unknown as PermissionCoordinator;
    setupMissionSubscriptions({
      missionManager: null,
      delegationManager: dm,
      agentManager: null as never,
      permissionCoordinator: pc,
      stateCache: null,
      dispatchModuleTask: vi.fn(),
    });
    return { clearSpy };
  }

  it('delegation.failed → onTermination → clearActiveScope(delegationId)【V-2 防泄漏核心】', () => {
    const id = makeDelegation();
    const { clearSpy } = setupWithSpy();
    expect(dm.fail(id, 'boom')).toBe(true);
    // V-2 不变量：fail 终态化后 active_scope 必清（否则跨 task 泄漏）
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it('delegation.completed → onTermination → clearActiveScope（成功路径也清 scope）', () => {
    const id = makeDelegation();
    const { clearSpy } = setupWithSpy();
    expect(dm.complete(id, 'done')).toBe(true);
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it('终态后再次 fail（幂等）不重复清（终态守卫）', () => {
    const id = makeDelegation();
    const { clearSpy } = setupWithSpy();
    dm.fail(id, 'first');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // 已终态 → fail 幂等 return false，不再 emit delegation.failed → 不再触发 onTermination
    expect(dm.fail(id, 'second')).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
