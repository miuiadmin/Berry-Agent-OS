/**
 * L3 scheduler — GoalJobsFace 单元测试（刀四 T7-B：goal→scheduler 操作面——
 * 组合根闭包注入窄面）。真 JobsStore（:memory: 真库）+ 面UnderTest 直构；
 * OS 注册器缺席/在场两态 + 四法语义。命令面全链（/goal wake → 面真身）在
 * app/goal.test.ts（真装配 + 假 OS 注册器）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { openStore, type Store } from '../persist/index.js';
import { JobsStore, migrations } from './index.js';
import { evaluateDue, parseSchedule } from './schedule.js';
import { createSchedulerApp, goalJobName, GOAL_JOB_OWNER } from './app.js';
import type { GoalJobsFace } from './app.js';

/** 当前测试库（每用例新建 :memory:——迁移链一次到位后交面） */
let store: Store;
let jobs: JobsStore;
let face: GoalJobsFace;
/** mountGoalJobs 收到的面（迟到注入回填观测） */
let mounted: GoalJobsFace | undefined;

beforeEach(async () => {
  store = openStore({ path: ':memory:', migrations });
  jobs = new JobsStore(store.connection);
  mounted = undefined;
  // 真 Context + 两服务薄壳（compaction 测试同款形态）——apply 内构造面并回填
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  ctx.provide('ui', { notify: () => undefined } as never);
  ctx.provide('channels', { registerCommand: () => () => undefined } as never);
  const plugin = createSchedulerApp({
    connection: store.connection,
    turnDepth: () => 0,
    lastUserMessageAt: () => null,
    backgroundAffordable: () => true,
    mountGoalJobs: (f) => {
      mounted = f;
      return () => {};
    },
  });
  await plugin.apply(ctx as never, ctx.config);
  expect(plugin.name).toBe('scheduler');
  expect(mounted).toBeDefined();
  face = mounted!;
});

/** 假 OS 注册器联动全链在 app/goal.test.ts（真装配 + fakeOsRegistrar）；本文件面默认无 OS 注册器 */

describe('GoalJobsFace：register（词法执法 + upsert + OS 联动）', () => {
  it('坏串响亮拒绝：行不写（词法管辖权在本面）', async () => {
    const r = await face.register({ goalId: 'g1', sessionId: 's1', schedule: 'nonsense', promptSnapshot: '目标' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('schedule 不合法');
    expect(jobs.get(goalJobName('g1'))).toBeUndefined();
  });

  it('OS 注册器缺席 = 行照写 + 回执如实示态（降级非错误）', async () => {
    const r = await face.register({ goalId: 'g1', sessionId: 's1', schedule: 'daily@09:00', promptSnapshot: '目标' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('OS 注册面未装配');
    const row = jobs.get(goalJobName('g1'))!;
    expect(row.owner).toBe(GOAL_JOB_OWNER);
    expect(row.sessionId).toBe('s1');
  });

  it('【回归锁 遗漏大扫 20260904-c 刀A】register 名冲突拒：用户先占名 goal-<id>——修前静默吞用户行（prompt 丢失/触发史继承污染）', async () => {
    // 用户行先占名（JobsStore.add——/tick add 同路落库）
    jobs.add('goal-g1', '我的手动任务', Date.now(), 'daily@08:00');
    const r = await face.register({
      goalId: 'g1',
      sessionId: 's1',
      schedule: 'daily@09:00',
      promptSnapshot: '续跑快照',
    });
    // 修前：ok true——upsert 覆写 prompt/schedule/session_id/owner，用户行被吞
    expect(r.ok).toBe(false);
    expect(r.message).toContain('占用');
    expect(r.message).toContain('/tick rm');
    // 用户行原样保留（owner 仍 NULL、prompt 未被覆写）
    const row = jobs.get('goal-g1')!;
    expect(row.owner).toBeNull();
    expect(row.prompt).toBe('我的手动任务');
  });
});

describe('GoalJobsFace：disable/enable/remove（生命周期位 + 幽灵行）', () => {
  it('无行三法全静默 no-op（未挂过钟的 goal 非错误）', async () => {
    await expect(face.disable('ghost')).resolves.toBeUndefined();
    await expect(face.enable('ghost')).resolves.toBeUndefined();
    await expect(face.remove('ghost')).resolves.toBeUndefined();
  });

  it('goalJobName 名约定：goal-<goalId>（确定性——重挂即同行）', async () => {
    await face.register({ goalId: 'g1', sessionId: 's1', schedule: 'every@1h', promptSnapshot: '目标' });
    expect(jobs.get('goal-g1')).toBeDefined();
  });
});

describe('GoalJobsFace：重挂行史语义（once 清零 / every 保留——定向复扫 20260902 第七轮 M-3）', () => {
  it('once@ 已触发后重挂新时刻：触发史随行清零，evaluateDue 应 wait 非 done（修前红）', async () => {
    const t0 = Date.now();
    // 首挂未来 60s 的 once 钟
    const first = await face.register({
      goalId: 'g1',
      sessionId: 's1',
      schedule: `once@${new Date(t0 + 60_000).toISOString()}`,
      promptSnapshot: '目标',
    });
    expect(first.ok).toBe(true);
    const name = goalJobName('g1');
    // 模拟首挂已到点触发（抢占推进 last_run_at——once 已跑 = 生命周期终）
    expect(jobs.reserveRun(name, t0 + 60_000, 'scheduled')).toBe('reserved');
    // 重挂新未来时刻（1h 后）：修前 putOwned 保留 last_run_at → once 分支
    // 无条件 done 短路——新时刻永不触发且回执谎称已登记（死钟）
    const again = await face.register({
      goalId: 'g1',
      sessionId: 's1',
      schedule: `once@${new Date(t0 + 3600_000).toISOString()}`,
      promptSnapshot: '目标',
    });
    expect(again.ok).toBe(true);
    const row = jobs.get(name)!;
    // 行刚经 register 重写——schedule 必非空（类型面 null 属行缺省态，此处不存在）
    const parsed = parseSchedule(row.schedule!, t0);
    if (!parsed.ok) throw new Error(`重挂后 schedule 应可解析：${row.schedule}`);
    const decision = evaluateDue(parsed.schedule, row.lastRunAt, row.createdAt, t0);
    // 修前 = done（回执谎称已登记）；修后 = wait 到新 at
    expect(decision).toEqual({ action: 'wait', nextAt: t0 + 3600_000 });
  });

  it('every@ 重挂保留触发史（防补拍双跑——upsert 语义锁，恒绿）', async () => {
    await face.register({ goalId: 'g1', sessionId: 's1', schedule: 'every@1h', promptSnapshot: '目标' });
    const name = goalJobName('g1');
    const firedAt = Date.now();
    expect(jobs.reserveRun(name, firedAt, 'scheduled')).toBe('reserved');
    // 重挂改间隔：last_run_at 保留（删了就会立即补拍一跑——K2-c 防补拍双跑口径）
    await face.register({ goalId: 'g1', sessionId: 's1', schedule: 'every@2h', promptSnapshot: '目标' });
    const row = jobs.get(name)!;
    expect(row.schedule).toBe('every@2h');
    expect(row.lastRunAt).toBe(firedAt);
  });
});

/* ---- SchedulerViewFace：桌面管理面（OS 三大管理面研究刀四——清单投影 + ----
 * 动词守卫单源 + 捕获 ui 相位法） */

describe('SchedulerViewFace：list 清单投影（nextRun 人读词五态 + OS 注册态三值）', () => {
  /** 局部装配（describe 级自持——不与文件级 beforeEach 的 goal 面共用捕获位） */
  const assemble = async (extra?: Partial<import('./app.js').SchedulerAppDeps>) => {
    const s = openStore({ path: ':memory:', migrations });
    const j = new JobsStore(s.connection);
    let view: import('./app.js').SchedulerViewFace | undefined;
    const realUi: string[] = [];
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    ctx.provide('ui', { notify: (text: string) => realUi.push(text) } as never);
    ctx.provide('channels', { registerCommand: () => () => undefined } as never);
    const plugin = createSchedulerApp({
      connection: s.connection,
      turnDepth: () => 0,
      lastUserMessageAt: () => null,
      backgroundAffordable: () => true,
      // mountSchedulerView 捕获（组合根 holder 同款回填观测）
      mountSchedulerView: (f) => {
        view = f;
        return () => {};
      },
      ...extra,
    });
    await plugin.apply(ctx as never, ctx.config);
    if (view === undefined) throw new Error('mountSchedulerView 未回填——装配面断链');
    return { s, j, view, realUi };
  };

  it('nextRun 五态人读词：仅手动 / ISO / once 已跑 / once 过窗 / 已到点待触发', async () => {
    const t0 = 1_700_000_000_000;
    const { j, view } = await assemble({ now: () => t0 });
    j.add('manual-job', '手动提示', t0, null); // schedule null → 仅手动
    j.add('every-job', '每时跑', t0, 'every@1h'); // wait → ISO（锚 = createdAt）
    // once 已跑：抢占推进 last_run_at → evaluateDue 无条件 done 短路
    j.add('once-ran', '一次', t0, `once@${new Date(t0 + 3_600_000).toISOString()}`);
    expect(j.reserveRun('once-ran', t0 + 3_600_000, 'scheduled')).toBe('reserved');
    // once 过窗：at 在 1h 前从未跑（超 10min 容忍窗）→ missed
    j.add('once-missed', '迟到', t0 - 7_200_000, `once@${new Date(t0 - 3_600_000).toISOString()}`);
    // once 窗内迟到：at 在 1min 前（10min 容忍窗内）→ fire
    j.add('once-due', '到点', t0 - 120_000, `once@${new Date(t0 - 60_000).toISOString()}`);
    const rows = await view.list();
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('manual-job')?.nextRun).toBe('仅手动');
    expect(byName.get('every-job')?.nextRun).toBe(new Date(t0 + 3_600_000).toISOString());
    expect(byName.get('once-ran')?.nextRun).toBe('once 已跑');
    expect(byName.get('once-missed')?.nextRun).toBe('once 过窗');
    expect(byName.get('once-due')?.nextRun).toBe('已到点待触发');
    // 注册器缺席 → 全行 absent（诊断态非错误）
    expect([...byName.values()].every((row) => row.osState === 'absent')).toBe(true);
  });

  it('注册器在场 → registered/unregistered 逐行探测', async () => {
    const { j, view } = await assemble({
      osRegistrar: {
        register: async () => ({ ok: true, message: '' }),
        unregister: async () => ({ ok: true, message: '' }),
        isRegistered: async (name) => name === 'reg-job',
      },
    });
    j.add('reg-job', '在册', 0, null);
    j.add('unreg-job', '未册', 0, null);
    const byName = new Map((await view.list()).map((row) => [row.name, row]));
    expect(byName.get('reg-job')?.osState).toBe('registered');
    expect(byName.get('unreg-job')?.osState).toBe('unregistered');
  });

  it('库外手编坏串行 → 坏声明串（清单不炸——诊断呈现）', async () => {
    const { s, view } = await assemble();
    // add 面词法过闸存不进坏串——坏行只能来自库外手编，直插模拟
    s.connection
      .prepare(
        `INSERT INTO jobs (name, prompt, cwd, schedule, last_run_at, created_at, updated_at,
                           last_run_reason, session_id, last_session_id, owner, owner_key, enabled)
         VALUES ('bad-row', 'p', NULL, 'garbage@x', NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, 1)`,
      )
      .run();
    const rows = await view.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nextRun).toBe('坏声明串');
  });
});

describe('SchedulerViewFace：dispatch 动词面（守卫单源 + 相位法）', () => {
  /** 局部装配（同上 describe 形态——dispatch 测试自持真库真面） */
  const assemble = async (extra?: Partial<import('./app.js').SchedulerAppDeps>) => {
    const s = openStore({ path: ':memory:', migrations });
    const j = new JobsStore(s.connection);
    let view: import('./app.js').SchedulerViewFace | undefined;
    const realUi: string[] = [];
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    ctx.provide('ui', { notify: (text: string) => realUi.push(text) } as never);
    ctx.provide('channels', { registerCommand: () => () => undefined } as never);
    const plugin = createSchedulerApp({
      connection: s.connection,
      turnDepth: () => 0,
      lastUserMessageAt: () => null,
      backgroundAffordable: () => true,
      mountSchedulerView: (f) => {
        view = f;
        return () => {};
      },
      ...extra,
    });
    await plugin.apply(ctx as never, ctx.config);
    if (view === undefined) throw new Error('mountSchedulerView 未回填——装配面断链');
    return { s, j, view, realUi };
  };

  it('守卫单源：goal 挂钟行经桌面腿 rm 同拒（与 /tick rm 同 handler by construction）', async () => {
    const { j, view } = await assemble();
    j.putOwned({
      name: goalJobName('g1'),
      prompt: '目标',
      schedule: 'every@1h',
      sessionId: 's1',
      owner: GOAL_JOB_OWNER,
      ownerKey: 'g1',
      now: 0,
    });
    const receipt = await view.dispatch(`rm ${goalJobName('g1')}`);
    expect(receipt).toContain('系统行');
    expect(j.get(goalJobName('g1'))).toBeDefined(); // 行未删
  });

  it('守卫单源：enable 在注册器缺席下回执不可用（诊断态如实示）', async () => {
    const { j, view } = await assemble();
    j.add('t1', '跑我', 0, null);
    const receipt = await view.dispatch('enable t1');
    expect(receipt).toContain('不可用');
  });

  it('相位法：dispatch 期同步回执收集返桌面，返回后迟到回执转发真 ui 通道', async () => {
    // runner 门闩：挂起 promise 手动放行——完成回执必然迟到于 dispatch 返回
    let release!: (value: import('./types.js').TickRunResult) => void;
    const gate = new Promise<import('./types.js').TickRunResult>((resolve) => {
      release = resolve;
    });
    const { j, view, realUi } = await assemble({ runJob: () => gate });
    j.add('t1', '跑我', 0, null);
    const receipt = await view.dispatch('run t1');
    expect(receipt).toContain('触发'); // 同步回执（gate 四判据过 + 抢占成功）
    expect(realUi).toHaveLength(0); // 迟到回执尚未发生——不混进桌面回执
    release({ exitCode: 0, stdout: 'done', stderr: '', durationMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // 微任务 flush
    expect(realUi.join('\n')).toContain('t1'); // 完成回执进真 ui 通道（不蒸发）
  });
});
