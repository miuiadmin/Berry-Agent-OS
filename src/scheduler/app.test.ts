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
