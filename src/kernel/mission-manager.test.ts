/**
 * MissionManager 单元测试。
 *
 * 使用 setAppHome 临时切换到临时目录，避免污染用户的 ~/.berry 目录。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { MissionManager } from './mission-manager.js';

let originalHome: string;
let testDir: string;
let mgr: MissionManager;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'mission-mgr-test-'));
  setAppHome(testDir);
  mgr = new MissionManager();
});

afterEach(() => {
  setAppHome(originalHome);
  rmSync(testDir, { recursive: true, force: true });
});

describe('MissionManager — Mission 生命周期', () => {
  it('createMission 创建目录和 plan.json', () => {
    const plan = mgr.createMission('重构 auth 模块', '用户要求...', [
      { what: '分析', who: 'code' },
    ], 'brain');
    const missionId = plan.mission.id;

    /** plan.json 可通过 readPlan 读回，说明文件已创建 */
    const readBack = mgr.readPlan(missionId);
    expect(readBack).not.toBeNull();

    expect(plan.mission.goal).toBe('重构 auth 模块');
    expect(plan.mission.created_by).toBe('brain');
    expect(plan.mission.context).toBe('用户要求...');
    expect(plan.mission.status).toBe('in_progress');
    expect(plan.tasks).toHaveLength(1);
  });

  it('listMissions 列出所有 mission', () => {
    mgr.createMission('mission-A', 'ctx', [], 'brain');
    mgr.createMission('mission-B', 'ctx', [], 'brain');

    const list = mgr.listMissions();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.find(m => m.goal === 'mission-A')).toBeDefined();
    expect(list.find(m => m.goal === 'mission-B')).toBeDefined();
  });
});

describe('MissionManager — Plan 读写', () => {
  it('readPlan 返回解析后的 plan', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    const missionId = plan.mission.id;
    const read = mgr.readPlan(missionId);
    expect(read).not.toBeNull();
    expect(read!.mission.goal).toBe('目标');
  });

  it('readPlan 对不存在的 mission 返回 null', () => {
    const plan = mgr.readPlan('m_nonexistent');
    expect(plan).toBeNull();
  });

  it('readSummary 返回格式化文本', () => {
    const plan = mgr.createMission('重构', 'ctx', [
      { what: '分析 auth', who: 'code' },
    ], 'brain');
    const summary = mgr.readSummary(plan.mission.id);
    expect(summary).not.toBeNull();
    expect(summary!).toContain('重构');
    expect(summary!).toContain('分析 auth');
  });
});

describe('MissionManager — Plan 变更', () => {
  it('updatePlan 修改任务状态', () => {
    const plan = mgr.createMission('目标', 'ctx', [
      { what: 'T1', who: 'code' },
    ], 'brain');
    const taskId = plan.tasks[0].id;

    mgr.updatePlan(plan.mission.id, { task_id: taskId, status: 'working' });
    const after = mgr.readPlan(plan.mission.id)!;
    expect(after.tasks[0].status).toBe('working');
  });

  it('updatePlan 添加新任务', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.updatePlan(plan.mission.id, {
      new_task: { what: '新建任务', who: 'code', depends_on: [] },
    });

    const after = mgr.readPlan(plan.mission.id)!;
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0].what).toBe('新建任务');
  });

  it('updatePlan 记录决策', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.updatePlan(plan.mission.id, { decision: { thought: '先做 X 再做 Y' } });

    const after = mgr.readPlan(plan.mission.id)!;
    expect(after.decisions.length).toBeGreaterThanOrEqual(1);
    expect(after.decisions[after.decisions.length - 1].thought).toBe('先做 X 再做 Y');
  });

  it('updatePlan 添加备注', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.updatePlan(plan.mission.id, { note: '这是备注' });

    const after = mgr.readPlan(plan.mission.id)!;
    expect(after.notes).toContain('这是备注');
  });

  it('所有任务 done 时自动 mark mission completed', () => {
    const plan = mgr.createMission('目标', 'ctx', [
      { what: 'T1', who: 'code' },
    ], 'brain');
    const taskId = plan.tasks[0].id;

    mgr.updatePlan(plan.mission.id, { task_id: taskId, status: 'done' });
    const after = mgr.readPlan(plan.mission.id)!;
    expect(after.mission.status).toBe('completed');
  });
});

describe('MissionManager — Squad 操作', () => {
  it('initSquad 创建 squad.json', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    const result = mgr.initSquad(plan.mission.id, [
      {
        id: 's-1',
        name: '开发组',
        depth: 1,
        goal: '完成开发',
        leader: 'code',
        members: [{ agent: 'code-1', role: 'work', on: '写代码', status: 'idle' }],
        status: 'waiting',
        signals: [],
      },
    ]);
    expect(result).not.toBeNull();
    expect(mgr.readSquad(plan.mission.id)).not.toBeNull();
  });

  it('createSquad 创建顶层 squad', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    const result = mgr.createSquad(plan.mission.id, {
      name: '开发组',
      goal: '写代码',
      leader: 'code',
    });
    expect(result).not.toBeNull();

    const squad = mgr.readSquad(plan.mission.id)!;
    expect(squad.org.squads).toHaveLength(1);
    expect(squad.org.squads[0].name).toBe('开发组');
    expect(squad.org.squads[0].depth).toBe(1);
  });

  it('createSquad 深度超过 3 时抛错', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, { name: 'L1', goal: 'g', leader: 'a' });
    const squad1 = mgr.readSquad(plan.mission.id)!;
    const s1 = squad1.org.squads[0];
    mgr.createSquad(plan.mission.id, { name: 'L2', goal: 'g', leader: 'a', parentSquadId: s1.id });
    const squad2 = mgr.readSquad(plan.mission.id)!;
    const s2 = squad2.org.squads[0].squads![0];
    mgr.createSquad(plan.mission.id, { name: 'L3', goal: 'g', leader: 'a', parentSquadId: s2.id });
    const squad3 = mgr.readSquad(plan.mission.id)!;
    const s3 = squad3.org.squads[0].squads![0].squads![0];
    // 第 4 层应失败（s3.depth=3，s4.depth=4 > MAX=3）
    expect(() => {
      mgr.createSquad(plan.mission.id, { name: 'L4', goal: 'g', leader: 'a', parentSquadId: s3.id });
    }).toThrow(/depth limit/);
  });

  it('updateMember 修改成员状态', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, {
      name: 'S',
      goal: 'g',
      leader: 'code',
      members: [{ agent: 'code-1', role: 'work', on: '写代码' }],
    });
    const squad = mgr.readSquad(plan.mission.id)!;
    const sid = squad.org.squads[0].id;

    const result = mgr.updateMember(plan.mission.id, sid, 'code-1', 'working');
    expect(result).not.toBeNull();
    const after = mgr.readSquad(plan.mission.id)!;
    expect(after.org.squads[0].members[0].status).toBe('working');
  });

  it('sendSignal 写入 squad 内部和全局 signals', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, { name: 'S', goal: 'g', leader: 'code' });
    const squad = mgr.readSquad(plan.mission.id)!;
    const sid = squad.org.squads[0].id;

    mgr.sendSignal(plan.mission.id, sid, 'code-1', 'blocker', '遇到问题');
    const after = mgr.readSquad(plan.mission.id)!;
    expect(after.org.squads[0].signals).toHaveLength(1);
    expect(after.signals).toHaveLength(1);
  });

  it('executeHandoff 创建交接记录', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'a' });
    mgr.createSquad(plan.mission.id, { name: 'B', goal: 'g', leader: 'b' });
    const squad = mgr.readSquad(plan.mission.id)!;

    mgr.executeHandoff(plan.mission.id, squad.org.squads[0].id, squad.org.squads[1].id, '交接内容');
    const after = mgr.readSquad(plan.mission.id)!;
    expect(after.handoffs).toHaveLength(1);
    expect(after.handoffs[0].what).toBe('交接内容');
  });
});

describe('MissionManager — HandoffContext 结构化（§5.3.11）', () => {
  it('executeHandoff 接受 sourceContext 并 JSON 序列化到 content', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'a' });
    mgr.createSquad(plan.mission.id, { name: 'B', goal: 'g', leader: 'b' });
    const squad = mgr.readSquad(plan.mission.id)!;

    const sourceContext = {
      originalInstruction: '重构 auth 模块',
      filesRead: ['src/auth.ts'],
      filesModified: [{ path: 'src/auth.ts' }],
      agentConversations: [{ with: 'learning', summary: '讨论方案', at: Date.now() }],
      currentProgress: '已完成 50%',
      blockers: [],
      handoffAt: Date.now(),
      fromAgent: 'a',
    };

    mgr.executeHandoff(
      plan.mission.id,
      squad.org.squads[0].id,
      squad.org.squads[1].id,
      '接力重构',
      undefined,
      sourceContext,
    );

    const after = mgr.readSquad(plan.mission.id)!;
    expect(after.handoffs[0].content).toBeDefined();
    // content 应该是 JSON 序列化结果
    const parsed = JSON.parse(after.handoffs[0].content!);
    expect(parsed.originalInstruction).toBe('重构 auth 模块');
    expect(parsed.filesRead).toContain('src/auth.ts');
  });

  it('readLatestHandoffContext 反序列化 JSON content', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'a' });
    mgr.createSquad(plan.mission.id, { name: 'B', goal: 'g', leader: 'b' });
    const squad = mgr.readSquad(plan.mission.id)!;

    mgr.executeHandoff(
      plan.mission.id,
      squad.org.squads[0].id,
      squad.org.squads[1].id,
      '接力',
      undefined,
      {
        originalInstruction: 'inst',
        filesRead: ['x.ts'],
        filesModified: [],
        agentConversations: [],
        currentProgress: 'p',
        blockers: [],
        handoffAt: Date.now(),
        fromAgent: 'a',
      },
    );

    const ctx = mgr.readLatestHandoffContext(
      plan.mission.id,
      squad.org.squads[0].id,
      squad.org.squads[1].id,
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.originalInstruction).toBe('inst');
    expect(ctx!.filesRead).toContain('x.ts');
  });

  it('readLatestHandoffContext 在无 handoff 时返回 null', () => {
    const plan = mgr.createMission('目标', 'ctx', [], 'brain');
    const ctx = mgr.readLatestHandoffContext(plan.mission.id, 'x', 'y');
    expect(ctx).toBeNull();
  });

  it('renderHandoffContext 输出含关键字段', () => {
    const ctx = {
      originalInstruction: '重构 auth',
      intentAnchor: { goal: '加固', successCriteria: ['测试通过'] },
      filesRead: ['src/auth.ts', 'src/jwt.ts'],
      filesModified: [{ path: 'src/auth.ts' }],
      agentConversations: [{ with: 'learning', summary: '讨论', at: Date.now() }],
      currentProgress: '改了一半',
      blockers: [{ reason: '等权限', raisedAt: Date.now(), raisedBy: 'a' }],
      scopeSnapshot: { blockPaths: ['/etc'], blockTools: ['shell'] },
      handoffAt: Date.now(),
      fromAgent: 'a',
    };
    const text = mgr.renderHandoffContext(ctx);
    expect(text).toContain('重构 auth');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('等权限');
    expect(text).toContain('不可访问路径');
    expect(text).toContain('不可用工具');
  });
});

describe('MissionManager — readContext 系统提示注入（§12.3/§12.6）', () => {
  it('readContext 返回结构化 MissionContext（含队友、前置任务、信号）', () => {
    const plan = mgr.createMission('重构 auth 模块', '用户要求...', [
      { what: '分析 auth', who: 'code' },
      { what: '修改 auth', who: 'code', depends_on: ['t-1'] },
      { what: '测试', who: 'code', depends_on: ['t-2'] },
    ], 'brain');

    // 先完成第一个任务
    mgr.updatePlan(plan.mission.id, { task_id: 't-1', status: 'done', result: '分析完毕' });
    mgr.updatePlan(plan.mission.id, { task_id: 't-2', status: 'working', progress: '正在改 auth.ts' });

    // 创建 squad
    mgr.createSquad(plan.mission.id, {
      name: '重构组',
      goal: '重构 auth',
      leader: 'code',
      members: [{ agent: 'learning', role: 'work', on: '查文档' }],
    });

    // 给 squad 加个 blocker 信号
    const squad = mgr.readSquad(plan.mission.id)!;
    mgr.sendSignal(plan.mission.id, squad.org.squads[0].id, 'learning', 'blocker', '文档找不到');

    // code agent 查 t-2 的上下文
    const ctx = mgr.readContext(plan.mission.id, 't-2', 'code');
    expect(ctx).not.toBeNull();
    expect(ctx!.missionId).toBe(plan.mission.id);
    expect(ctx!.goal).toBe('重构 auth 模块');
    expect(ctx!.currentTaskId).toBe('t-2');
    expect(ctx!.currentTaskWhat).toBe('修改 auth');
    expect(ctx!.squadGoal).toBe('重构 auth');
    expect(ctx!.squadTeammates.length).toBeGreaterThan(0);
    expect(ctx!.squadTeammates.some(t => t.agent === 'learning')).toBe(true);
    expect(ctx!.completedTasks.some(t => t.id === 't-1' && t.result === '分析完毕')).toBe(true);
    expect(ctx!.inProgressTasks.some(t => t.id === 't-2')).toBe(false); // 自己不算
    expect(ctx!.unresolvedSignals.some(s => s.msg === '文档找不到')).toBe(true);
  });

  it('readContext 在 agent 不在 squad 中时给默认 work 角色', () => {
    const plan = mgr.createMission('目标', 'ctx', [
      { what: 'T1', who: 'code' },
    ], 'brain');

    // 不创建 squad
    const ctx = mgr.readContext(plan.mission.id, 't-1', 'code');
    expect(ctx).not.toBeNull();
    expect(ctx!.squadRole).toBe('work');
    expect(ctx!.squadGoal).toBe(plan.mission.goal);
    expect(ctx!.squadTeammates).toHaveLength(0);
  });

  it('readContext 在 missionId 不存在时返回 null', () => {
    const ctx = mgr.readContext('m_nonexistent', 't-1', 'code');
    expect(ctx).toBeNull();
  });

  it('readContext 在 planTaskId 不存在时返回 null', () => {
    const plan = mgr.createMission('目标', 'ctx', [{ what: 'T1', who: 'code' }], 'brain');
    const ctx = mgr.readContext(plan.mission.id, 't-99', 'code');
    expect(ctx).toBeNull();
  });

  it('renderContext 返回包含 mission 目标和队友的文本', () => {
    const plan = mgr.createMission('重构 auth', 'ctx', [
      { what: 'T1', who: 'code' },
    ], 'brain');
    mgr.createSquad(plan.mission.id, {
      name: '重构组',
      goal: '完成重构',
      leader: 'code',
      members: [{ agent: 'learning', role: 'work', on: '查文档' }],
    });

    const text = mgr.renderContext(plan.mission.id, 't-1', 'code');
    expect(text).not.toBeNull();
    expect(text!).toContain('Mission 目标: 重构 auth');
    expect(text!).toContain('@learning');
    expect(text!).toContain('当前任务上下文');
  });
});
