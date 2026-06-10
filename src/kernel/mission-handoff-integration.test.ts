/**
 * HandoffContext + MissionContext 端到端集成测试（§5.3.11 + §12.3）。
 *
 * 覆盖完整链路：
 *   1. createMission（含 plan）
 *   2. createSquad（多角色：lead + work + check）
 *   3. squad sendSignal（blocker）
 *   4. executeHandoff（with sourceContext 完整结构）
 *   5. readLatestHandoffContext（反序列化 + 完整字段校验）
 *   6. renderHandoffContext（输出含关键字段）
 *   7. readContext（mission + squad + teammates + signals 全聚合）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { MissionManager } from './mission-manager.js';
import type { HandoffContext } from '../contracts/delegation.js';

let originalHome: string;
let testDir: string;
let mgr: MissionManager;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'mission-handoff-test-'));
  setAppHome(testDir);
  mgr = new MissionManager();
});

afterEach(() => {
  setAppHome(originalHome);
  rmSync(testDir, { recursive: true, force: true });
});

describe('HandoffContext 端到端集成（§5.3.11）', () => {
  it('executeHandoff 写入 sourceContext 后 readLatestHandoffContext 能完整反序列化', () => {
    const plan = mgr.createMission('重构 auth 模块', '用户要求...', [
      { what: '分析 auth.ts', who: 'code', depends_on: [] },
      { what: '实施修改', who: 'code', depends_on: ['t-1'] },
      { what: '验证', who: 'code', depends_on: ['t-2'] },
    ], 'brain');

    const missionId = plan.mission.id;

    // 1. 创建两个 squad
    mgr.createSquad(missionId, {
      name: '重构组',
      goal: '完成代码重构',
      leader: 'code',
      members: [
        { agent: 'learning', role: 'work', on: '查文档' },
        { agent: 'memory', role: 'check', on: '验证完整性' },
      ],
    });
    mgr.createSquad(missionId, {
      name: '验证组',
      goal: '回归测试',
      leader: 'memory',
      members: [],
    });

    const squadFile = mgr.readSquad(missionId)!;
    const refactorSquad = squadFile.org.squads[0];
    const verifySquad = squadFile.org.squads[1];

    // 2. 重构组发一个 blocker 信号
    mgr.sendSignal(missionId, refactorSquad.id, 'code', 'blocker', 'auth.ts 依赖循环，需先重构 utils');

    // 3. 重构组 → 验证组 handoff，携带完整 sourceContext
    const sourceContext: HandoffContext = {
      originalInstruction: '重构 auth 模块',
      intentAnchor: {
        goal: '降低模块耦合',
        successCriteria: ['auth.ts < 300 行', '无循环依赖', '测试通过'],
        scope: { include: ['src/auth/*'], exclude: ['node_modules/**'] },
      },
      filesRead: ['src/auth.ts', 'src/utils/index.ts'],
      filesModified: [{ path: 'src/auth.ts', diffHash: 'sha256:abc123' }],
      agentConversations: [
        { with: 'learning', summary: '讨论 ESM 重构方案', at: Date.now() },
        { with: 'brain', summary: '上报依赖循环', at: Date.now() },
      ],
      currentProgress: '已分析完结构，开始重构 utils/index.ts',
      blockers: [
        { reason: 'auth.ts 依赖循环', raisedAt: Date.now(), raisedBy: 'code' },
      ],
      scopeSnapshot: { blockPaths: ['node_modules'], blockTools: [] },
      handoffAt: Date.now(),
      fromAgent: 'code',
    };

    mgr.executeHandoff(
      missionId,
      refactorSquad.id,
      verifySquad.id,
      '重构完成需回归测试',
      undefined,
      sourceContext,
    );

    // 4. 反序列化读取
    const restored = mgr.readLatestHandoffContext(missionId, refactorSquad.id, verifySquad.id);
    expect(restored).not.toBeNull();
    expect(restored!.originalInstruction).toBe('重构 auth 模块');
    expect(restored!.intentAnchor?.successCriteria).toEqual([
      'auth.ts < 300 行',
      '无循环依赖',
      '测试通过',
    ]);
    expect(restored!.filesRead).toEqual(['src/auth.ts', 'src/utils/index.ts']);
    expect(restored!.filesModified[0]).toEqual({ path: 'src/auth.ts', diffHash: 'sha256:abc123' });
    expect(restored!.agentConversations).toHaveLength(2);
    expect(restored!.blockers[0].reason).toContain('依赖循环');
    expect(restored!.scopeSnapshot?.blockPaths).toEqual(['node_modules']);
    expect(restored!.fromAgent).toBe('code');
  });

  it('renderHandoffContext 输出包含所有关键字段', () => {
    const plan = mgr.createMission('目标', 'ctx', [
      { what: 'T1', who: 'code' },
    ]);
    mgr.createSquad(plan.mission.id, {
      name: 'A',
      goal: 'g',
      leader: 'code',
    });
    mgr.createSquad(plan.mission.id, {
      name: 'B',
      goal: 'g',
      leader: 'b',
    });
    const squads = mgr.readSquad(plan.mission.id)!.org.squads;

    const ctx: HandoffContext = {
      originalInstruction: 'inst',
      filesRead: ['f1.ts', 'f2.ts'],
      filesModified: [{ path: 'f3.ts' }],
      agentConversations: [{ with: 'learning', summary: '讨论', at: Date.now() }],
      currentProgress: 'p',
      blockers: [{ reason: 'b1', raisedAt: Date.now(), raisedBy: 'code' }],
      handoffAt: Date.now(),
      fromAgent: 'code',
    };
    mgr.executeHandoff(plan.mission.id, squads[0].id, squads[1].id, 'what', undefined, ctx);

    const text = mgr.renderHandoffContext(ctx);
    expect(text).toContain('交接上下文');
    expect(text).toContain('inst'); // originalInstruction
    expect(text).toContain('f1.ts');
    expect(text).toContain('f3.ts');
    expect(text).toContain('讨论'); // agentConversations summary
    expect(text).toContain('b1'); // blocker reason
  });

  it('不传 sourceContext 时 content 退化为字符串透传', () => {
    const plan = mgr.createMission('m', 'c', [{ what: 't', who: 'code' }]);
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'code' });
    mgr.createSquad(plan.mission.id, { name: 'B', goal: 'g', leader: 'b' });
    const squads = mgr.readSquad(plan.mission.id)!.org.squads;

    mgr.executeHandoff(plan.mission.id, squads[0].id, squads[1].id, 'what', 'fallback content');

    const restored = mgr.readLatestHandoffContext(plan.mission.id, squads[0].id, squads[1].id);
    expect(restored).not.toBeNull();
    // 不传 sourceContext → content 是 fallback 字符串
    expect(restored!.originalInstruction).toBe('fallback content');
    // 其他字段是默认值
    expect(restored!.filesRead).toEqual([]);
    expect(restored!.filesModified).toEqual([]);
  });

  it('多次 handoff 后 readLatestHandoffContext 取最新一次', () => {
    const plan = mgr.createMission('m', 'c', [{ what: 't', who: 'code' }]);
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'code' });
    mgr.createSquad(plan.mission.id, { name: 'B', goal: 'g', leader: 'b' });
    const squads = mgr.readSquad(plan.mission.id)!.org.squads;

    // 第一次 handoff
    mgr.executeHandoff(plan.mission.id, squads[0].id, squads[1].id, 'first',
      undefined,
      { originalInstruction: 'first', filesRead: [], filesModified: [], agentConversations: [], currentProgress: 'p1', blockers: [], handoffAt: Date.now(), fromAgent: 'code' });

    // 第二次 handoff（更新 pending → delivered）
    mgr.executeHandoff(plan.mission.id, squads[0].id, squads[1].id, 'second',
      undefined,
      { originalInstruction: 'second', filesRead: [], filesModified: [], agentConversations: [], currentProgress: 'p2', blockers: [], handoffAt: Date.now(), fromAgent: 'code' });

    const restored = mgr.readLatestHandoffContext(plan.mission.id, squads[0].id, squads[1].id);
    expect(restored!.originalInstruction).toBe('second');
    expect(restored!.currentProgress).toBe('p2');
  });
});

describe('MissionContext 完整聚合（§12.3）', () => {
  it('readContext 返回含 squad 队友 + 任务进度 + 阻塞信号的完整结构', () => {
    const plan = mgr.createMission('build feature X', '用户要求...', [
      { what: '设计 API', who: 'code' },
      { what: '实现', who: 'code', depends_on: ['t-1'] },
      { what: '测试', who: 'code', depends_on: ['t-2'] },
    ]);
    const missionId = plan.mission.id;

    // 完成 t-1，标记 t-2 进行中
    mgr.updatePlan(missionId, { task_id: 't-1', status: 'done', result: 'API 设计完成' });
    mgr.updatePlan(missionId, { task_id: 't-2', status: 'working', progress: '实现 60%' });

    mgr.createSquad(missionId, {
      name: '开发组',
      goal: '完成 feature X',
      leader: 'code',
      members: [
        { agent: 'learning', role: 'work', on: '查技术文档' },
        { agent: 'memory', role: 'check', on: '验证完整性' },
      ],
    });

    const squad = mgr.readSquad(missionId)!.org.squads[0];
    mgr.sendSignal(missionId, squad.id, 'learning', 'blocker', '技术文档缺失');

    // code agent 查 t-2 的上下文（code 是 leader 身份）
    const ctx = mgr.readContext(missionId, 't-2', 'code');
    expect(ctx).not.toBeNull();
    expect(ctx!.missionId).toBe(missionId);
    expect(ctx!.goal).toBe('build feature X');
    expect(ctx!.currentTaskId).toBe('t-2');
    expect(ctx!.currentTaskWhat).toBe('实现');
    expect(ctx!.squadGoal).toBe('完成 feature X');
    expect(ctx!.squadRole).toBe('lead');
    expect(ctx!.squadOn).toBe('完成 feature X');
    // 队友应该包含 learning 和 memory（不含自己）
    const teammates = ctx!.squadTeammates.map(t => t.agent);
    expect(teammates).toContain('learning');
    expect(teammates).toContain('memory');
    // 已完成任务（不含自己）
    expect(ctx!.completedTasks.some(t => t.id === 't-1' && t.result === 'API 设计完成')).toBe(true);
    // 进行中任务（不含自己）
    expect(ctx!.inProgressTasks.some(t => t.id === 't-2')).toBe(false); // 自己不算
    // 未解决信号
    expect(ctx!.unresolvedSignals.some(s => s.msg === '技术文档缺失')).toBe(true);
  });
});