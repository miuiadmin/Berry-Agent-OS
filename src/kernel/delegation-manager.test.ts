import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../memory/db.js';
import { initEventBus, getEventBus } from './event-bus.js';
import { TaskManager } from './task-manager.js';
import { DelegationManager } from './delegation-manager.js';
import { isDelegationTerminal } from '../contracts/delegation.js';

/**
 * DelegationManager 收口语义单测 —— heartbeat 正确性的基础。
 *
 * 背景：TaskHeartbeatManager 的心跳源遍历 delegationManager.getAll()，对非终态 entry 发 task.heartbeat。
 * 若 delegation 完成后 state 不收口到终态（completed/failed），已完成的异步委派会被持续误发心跳。
 *
 * 一次修复（orchestrator handleForegroundTaskResult 的 !pending 分支补 complete/fail）依赖本类
 * 的三个不变量，本测试钉死它们，防止未来重构破坏收口机制：
 *   1. complete()/fail() 把 state 置终态
 *   2. 终态后 complete/fail 幂等（return false，不重复触发 taskManager 完成）
 *   3. getAll() 返回的终态 entry 被 isDelegationTerminal 过滤（心跳源不再扫到）
 */
describe('DelegationManager 收口语义（heartbeat 正确性基础）', () => {
  let dir: string;
  let dm: DelegationManager;

  /** 构造一个处于 delegated 初态的 delegation（模拟 orchestrator dispatchFeedbackExtraction 派发后的状态） */
  function makeDelegation(): string {
    dir = mkdtempSync(join(tmpdir(), 'berry-dm-'));
    initDb(join(dir, 'test.db'));
    // DelegationManager.create 内部用全局 getEventBus() emit delegation.created，
    // 需先初始化全局实例（每个用例独立，避免跨用例事件串扰）
    initEventBus();
    const tm = new TaskManager(getDb(), getEventBus());
    dm = new DelegationManager(tm);
    return dm.create({
      sessionId: 's1',
      correlationId: 'c1',
      taskType: 'delegation',
      requester: 'brain',
      targetAgent: 'evolution',
      targetKind: 'internal',
      foreground: false,
      inputPayload: { taskType: 'extract_feedback' },
    });
  }

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('complete() 把 delegation 置终态 completed', () => {
    const id = makeDelegation();
    expect(dm.complete(id, 'done')).toBe(true);
    const entry = dm.get(id);
    expect(entry!.state).toBe('completed');
    expect(isDelegationTerminal(entry!.state)).toBe(true);
  });

  it('fail() 把 delegation 置终态 failed', () => {
    const id = makeDelegation();
    expect(dm.fail(id, 'boom')).toBe(true);
    const entry = dm.get(id);
    expect(entry!.state).toBe('failed');
    expect(isDelegationTerminal(entry!.state)).toBe(true);
  });

  it('终态后 complete/fail 幂等（return false，state 不变）', () => {
    // orchestrator 的 !pending 分支可能在 task 已 completed 后才补收口 delegation，
    // 此时 taskManager.complete 已终态返回 false，delegation 这边首次 complete 仍须成功置终态；
    // 之后任何重复调用都幂等 no-op。
    const id = makeDelegation();
    expect(dm.complete(id, 'done')).toBe(true);
    expect(dm.complete(id, 'again')).toBe(false);
    expect(dm.fail(id, 'late')).toBe(false);
    expect(dm.get(id)!.state).toBe('completed');
  });

  it('getAll() 中已收口 entry 被 isDelegationTerminal 过滤（心跳源不再扫到）', () => {
    const id = makeDelegation();
    dm.complete(id, 'done');
    // 模拟 TaskHeartbeatManager 的 getActiveDelegations 过滤逻辑
    const active = dm.getAll().filter((e) => !isDelegationTerminal(e.state));
    expect(active).toHaveLength(0);
  });

  it('未收口 entry 仍被心跳源扫到（对照：确认过滤确实依赖收口）', () => {
    makeDelegation();
    const active = dm.getAll().filter((e) => !isDelegationTerminal(e.state));
    expect(active).toHaveLength(1);
  });
});
