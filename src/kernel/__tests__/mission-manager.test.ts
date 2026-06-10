/**
 * MissionManager 单元测试 — 验证 mission 生命周期管理。
 *
 * 使用隔离的临时目录，每个 describe 块有自己的 manager 实例。
 * 覆盖：创建/读取/更新/完成/squad/信号/交接/列表
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissionManager } from '../../kernel/mission-manager.js';
import { setAppHome, getAppHome } from '../../utils/paths.js';

const originalAppHome = getAppHome();
let tempDir: string;
let manager: MissionManager;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mission-test-'));
  setAppHome(tempDir);
  manager = new MissionManager();
});

afterEach(() => {
  setAppHome(originalAppHome);
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── 创建 Mission ───

describe('createMission', () => {
  it('应该创建 mission 目录和 plan.json', () => {
    const plan = manager.createMission(
      '重构 auth 模块',
      '用户要求重构',
      [
        { what: '分析 auth.ts', who: 'code', depends_on: [] },
        { what: '写测试', who: 'code', depends_on: ['t-1'] },
      ],
    );

    expect(plan.mission.goal).toBe('重构 auth 模块');
    expect(plan.mission.status).toBe('in_progress');
    expect(plan.mission.created_by).toBe('brain');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe('t-1');
    expect(plan.tasks[0].status).toBe('waiting');
    expect(plan.tasks[1].depends_on).toEqual(['t-1']);
    expect(plan.decisions).toHaveLength(1);

    // 验证文件存在
    const planPath = join(tempDir, 'missions', plan.mission.id, 'plan.json');
    expect(existsSync(planPath)).toBe(true);
  });

  it('应该支持自定义创建者', () => {
    const plan = manager.createMission('测试', 'ctx', [], 'code');
    expect(plan.mission.created_by).toBe('code');
  });

  it('空任务列表也应正常工作', () => {
    const plan = manager.createMission('空任务', 'ctx', []);
    expect(plan.tasks).toHaveLength(0);
  });
});

// ─── 读取 Plan ───

describe('readPlan / readSummary', () => {
  it('应该能读回创建的 plan', () => {
    const created = manager.createMission('测试', 'ctx', [
      { what: '做某事', who: 'code' },
    ]);
    const read = manager.readPlan(created.mission.id);

    expect(read).not.toBeNull();
    expect(read!.mission.id).toBe(created.mission.id);
    expect(read!.tasks).toHaveLength(1);
  });

  it('不存在的 mission 应返回 null', () => {
    expect(manager.readPlan('nonexistent')).toBeNull();
  });

  it('readSummary 应返回格式化的摘要', () => {
    const created = manager.createMission('重构 auth', 'ctx', [
      { what: '分析', who: 'code' },
      { what: '实现', who: 'code', depends_on: ['t-1'] },
    ]);
    const summary = manager.readSummary(created.mission.id);

    expect(summary).toContain('重构 auth');
    expect(summary).toContain('t-1');
    expect(summary).toContain('t-2');
    expect(summary).toContain('@code');
  });
});

// ─── 更新 Plan ───

describe('updatePlan', () => {
  it('应该能更新任务状态', () => {
    const created = manager.createMission('测试', 'ctx', [
      { what: '做某事', who: 'code' },
    ]);

    const updated = manager.updatePlan(created.mission.id, {
      task_id: 't-1',
      status: 'working',
      progress: '正在处理',
    });

    expect(updated).not.toBeNull();
    expect(updated!.tasks[0].status).toBe('working');
    expect(updated!.tasks[0].progress).toBe('正在处理');
  });

  it('应该能标记任务完成', () => {
    const created = manager.createMission('测试', 'ctx', [
      { what: '做某事', who: 'code' },
    ]);

    manager.updatePlan(created.mission.id, {
      task_id: 't-1',
      status: 'done',
      result: '已完成',
    });

    const plan = manager.readPlan(created.mission.id);
    expect(plan!.tasks[0].status).toBe('done');
    expect(plan!.tasks[0].result).toBe('已完成');
  });

  it('应该能新增任务', () => {
    const created = manager.createMission('测试', 'ctx', [
      { what: '任务1', who: 'code' },
    ]);

    const updated = manager.updatePlan(created.mission.id, {
      new_task: { what: '新增任务', who: 'learning', depends_on: ['t-1'] },
    });

    expect(updated!.tasks).toHaveLength(2);
    expect(updated!.tasks[1].id).toBe('t-2');
    expect(updated!.tasks[1].what).toBe('新增任务');
  });

  it('应该能记录决策', () => {
    const created = manager.createMission('测试', 'ctx', []);
    manager.updatePlan(created.mission.id, {
      decision: { thought: '决定先做分析' },
    });

    const plan = manager.readPlan(created.mission.id);
    expect(plan!.decisions).toHaveLength(2);
    expect(plan!.decisions[1].thought).toBe('决定先做分析');
  });

  it('应该能添加备注', () => {
    const created = manager.createMission('测试', 'ctx', []);
    manager.updatePlan(created.mission.id, { note: '重要提醒' });

    const plan = manager.readPlan(created.mission.id);
    expect(plan!.notes).toContain('重要提醒');
  });

  it('所有任务完成后 mission 应自动标记为 completed', () => {
    const created = manager.createMission('测试', 'ctx', [
      { what: '任务1', who: 'code' },
      { what: '任务2', who: 'code' },
    ]);

    manager.updatePlan(created.mission.id, { task_id: 't-1', status: 'done' });
    manager.updatePlan(created.mission.id, { task_id: 't-2', status: 'done' });

    const plan = manager.readPlan(created.mission.id);
    expect(plan!.mission.status).toBe('completed');
  });

  it('不存在的 mission 应返回 null', () => {
    expect(manager.updatePlan('nonexistent', { note: 'test' })).toBeNull();
  });
});

// ─── Squad 操作 ───

describe('Squad', () => {
  it('initSquad 应创建 squad.json', () => {
    const plan = manager.createMission('测试', 'ctx', []);
    const result = manager.initSquad(plan.mission.id, [{
      id: 's-1', name: '代码组', depth: 1, goal: '实现功能',
      leader: 'code', members: [], status: 'waiting', signals: [],
    }]);

    expect(result).not.toBeNull();
    expect(result!.org.squads).toHaveLength(1);
    expect(result!.org.squads[0].name).toBe('代码组');
  });

  it('createSquad 应验证深度限制', () => {
    const plan = manager.createMission('测试', 'ctx', []);
    manager.initSquad(plan.mission.id, [{
      id: 's-1', name: '组1', depth: 1, goal: 'G', leader: 'code',
      members: [], status: 'working', signals: [],
      squads: [{
        id: 's-1a', name: '子组', depth: 2, goal: 'G', leader: 'code',
        members: [], status: 'working', signals: [],
        squads: [{
          id: 's-1a-1', name: '孙组', depth: 3, goal: 'G', leader: 'code',
          members: [], status: 'working', signals: [],
        }],
      }],
    }]);

    // 尝试在 depth=3 的 squad 下再创建子 squad → 应该失败
    expect(() => {
      manager.createSquad(plan.mission.id, {
        name: '超限', goal: 'G', parentSquadId: 's-1a-1', leader: 'code',
      });
    }).toThrow('depth limit exceeded');
  });

  it('sendSignal 应同时写入 squad.signals 和全局 signals', () => {
    const plan = manager.createMission('测试', 'ctx', []);
    manager.initSquad(plan.mission.id, [{
      id: 's-1', name: '组1', depth: 1, goal: 'G', leader: 'code',
      members: [], status: 'working', signals: [],
    }]);

    manager.sendSignal(plan.mission.id, 's-1', 'code', 'progress', '50% 完成');

    const squad = manager.readSquad(plan.mission.id);
    expect(squad!.org.squads[0].signals).toHaveLength(1);
    expect(squad!.signals).toHaveLength(1);
    expect(squad!.signals[0].msg).toBe('50% 完成');
  });

  it('executeHandoff 应创建交接记录', () => {
    const plan = manager.createMission('测试', 'ctx', []);
    manager.initSquad(plan.mission.id, [
      { id: 's-1', name: '组1', depth: 1, goal: 'G', leader: 'code', members: [], status: 'done', signals: [] },
      { id: 's-2', name: '组2', depth: 1, goal: 'G', leader: 'skills', members: [], status: 'waiting', signals: [] },
    ]);

    manager.executeHandoff(plan.mission.id, 's-1', 's-2', '代码文件列表', 'auth.ts, session.ts');

    const squad = manager.readSquad(plan.mission.id);
    expect(squad!.handoffs).toHaveLength(1);
    expect(squad!.handoffs[0].status).toBe('delivered');
    expect(squad!.handoffs[0].content).toBe('auth.ts, session.ts');
  });
});

// ─── 列出 Mission ───

describe('listMissions', () => {
  it('应该返回所有 mission', () => {
    manager.createMission('任务1', 'ctx', [{ what: 'A', who: 'code' }]);
    manager.createMission('任务2', 'ctx', [{ what: 'B', who: 'code' }]);

    const list = manager.listMissions();
    expect(list).toHaveLength(2);
    expect(list.map(m => m.goal)).toEqual(expect.arrayContaining(['任务1', '任务2']));
  });

  it('没有 mission 时应返回空数组', () => {
    // 使用隔离的 manager（新建 tempDir 在 beforeEach 里）
    expect(manager.listMissions()).toEqual([]);
  });
});
