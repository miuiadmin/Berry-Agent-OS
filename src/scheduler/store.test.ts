/**
 * L3 scheduler — jobs 表 DAO 集成测试（JobsStore，经 persist 迁移框架建表后
 * 真库 :memory: SQLite，无 mock——goal 表族同款）。逐方法语义 + **执行前抢占
 * 三态**（reserve-then-run：reserved/missing/lost-race——冷读 #1 裁决的
 * 护栏语义在此锁死）+ v9 三列（记因/归属）读写。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import { JobsStore, migrations, JOB_NAME_PATTERN } from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移链 v7+v9 一次到位后交 DAO） */
let store: Store;
let db: JobsStore;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations });
  db = new JobsStore(store.connection);
});

describe('add / get / list / remove：任务行 CRUD', () => {
  it('新插（无 schedule）：预留位全 NULL——v9 三列亦 NULL', () => {
    expect(db.add('daily-report', '总结今日进度', 1000)).toBe('added');
    const job = db.get('daily-report')!;
    expect(job).toBeDefined();
    expect(job.name).toBe('daily-report');
    expect(job.prompt).toBe('总结今日进度');
    expect(job.cwd).toBeNull();
    expect(job.schedule).toBeNull();
    expect(job.lastRunAt).toBeNull();
    expect(job.createdAt).toBe(1000);
    expect(job.updatedAt).toBe(1000);
    // v9 三列缺省 NULL（记因/归属未涉）
    expect(job.lastRunReason).toBeNull();
    expect(job.sessionId).toBeNull();
    expect(job.lastSessionId).toBeNull();
  });

  it('带 schedule 新插：原样串落库（DAO 不解析——执法在命令层 parseSchedule）', () => {
    expect(db.add('briefing', '每日简报', 1000, 'daily@08:30')).toBe('added');
    expect(db.get('briefing')!.schedule).toBe('daily@08:30');
  });

  it('同名拒（主键即身份——duplicate 不改原行）', () => {
    expect(db.add('a', '旧指令', 100)).toBe('added');
    expect(db.add('a', '新指令', 200)).toBe('duplicate');
    expect(db.get('a')!.prompt).toBe('旧指令');
    expect(db.get('a')!.updatedAt).toBe(100);
  });

  it('list 按 name 字典序；get 不存在返回 undefined', () => {
    expect(db.get('x')).toBeUndefined();
    db.add('beta', 'b', 1);
    db.add('alpha', 'a', 2);
    expect(db.list().map((j) => j.name)).toEqual(['alpha', 'beta']);
  });

  it('remove：删到 true / 不存在 false', () => {
    db.add('a', 'p', 1);
    expect(db.remove('a')).toBe(true);
    expect(db.remove('a')).toBe(false);
    expect(db.get('a')).toBeUndefined();
  });

  it('任务名词法：合法样本通过 / 非法样本拒（词法执法面在命令层消费）', () => {
    expect(JOB_NAME_PATTERN.test('daily-report')).toBe(true);
    expect(JOB_NAME_PATTERN.test('job_2')).toBe(true);
    expect(JOB_NAME_PATTERN.test('-bad')).toBe(false); // 前导连字符（防旗标歧义）
    expect(JOB_NAME_PATTERN.test('a/b')).toBe(false); // 斜杠
    expect(JOB_NAME_PATTERN.test('a b')).toBe(false); // 空白
  });
});

describe('reserveRun：执行前抢占（reserve-then-run 三态 + v9 记因）', () => {
  it('任务不存在 → missing', () => {
    expect(db.reserveRun('ghost', 1000, 'manual')).toBe('missing');
  });

  it('首次抢占 reserved：last_run_at NULL → 推进 + 记因同笔落列', () => {
    db.add('a', 'p', 100);
    expect(db.reserveRun('a', 5000, 'scheduled')).toBe('reserved');
    const job = db.get('a')!;
    expect(job.lastRunAt).toBe(5000);
    expect(job.updatedAt).toBe(5000);
    expect(job.lastRunReason).toBe('scheduled');
  });

  it('再次手动触发合法：新 last_run_at 为新比对键（手动连跑两次是用户裁量；记因随笔换）', () => {
    db.add('a', 'p', 100);
    expect(db.reserveRun('a', 1000, 'scheduled')).toBe('reserved');
    expect(db.reserveRun('a', 2000, 'manual')).toBe('reserved'); // get 拿到 1000 → 条件更新成功
    const job = db.get('a')!;
    expect(job.lastRunAt).toBe(2000);
    expect(job.lastRunReason).toBe('manual');
  });

  it('lost-race：读值后他方抢先（旧比对键条件更新 changes=0 让路）', () => {
    db.add('a', 'p', 100);
    // 编排双进程竞写：进程 B 先读行（拿到 NULL 比对键）……
    const expected = db.get('a')!.lastRunAt; // null
    // ……进程 A 抢先抢占成功……
    expect(db.reserveRun('a', 1111, 'manual')).toBe('reserved');
    // ……进程 B 携旧比对键条件更新——changes=0 让路（token 未花，正确）
    const changes = store.connection
      .prepare(
        `UPDATE jobs SET last_run_at = ?, last_run_reason = ?, updated_at = ?
         WHERE name = ? AND last_run_at IS ?`,
      )
      .run(2222, 'manual', 2222, 'a', expected).changes;
    expect(changes).toBe(0);
    expect(db.get('a')!.lastRunAt).toBe(1111); // A 的推进不被 B 覆写
  });
});

describe('v9 三列写路：missed 记因 + 会话归属', () => {
  it('markMissed：记因落列但不推进 last_run_at（没触发就不动触发时刻）', () => {
    db.add('a', 'p', 100, 'once@2099-01-01T00:00');
    db.markMissed('a', 500);
    const job = db.get('a')!;
    expect(job.lastRunReason).toBe('missed');
    expect(job.lastRunAt).toBeNull(); // 关键：未推进
    expect(job.updatedAt).toBe(500);
  });

  it('recordLastSession / setSessionTarget：归属两列独立读写', () => {
    db.add('a', 'p', 100);
    db.recordLastSession('a', 'sess-1', 200);
    expect(db.get('a')!.lastSessionId).toBe('sess-1');
    db.setSessionTarget('a', 'sess-target', 300);
    expect(db.get('a')!.sessionId).toBe('sess-target');
    // 解绑（null 回写——投递二值的另一边）
    db.setSessionTarget('a', null, 400);
    expect(db.get('a')!.sessionId).toBeNull();
  });
});

describe('v14 归属族：owner/owner_key/enabled 三列（goal 挂钟承载）', () => {
  /** 造一行 goal 挂钟 upsert 输入（字段可覆写——名确定性约定 goal-<goalId>） */
  const ownedJob = (goalId: string, over: Partial<Parameters<JobsStore['putOwned']>[0]> = {}) => ({
    name: `goal-${goalId}`,
    prompt: `目标：${goalId}`,
    schedule: 'daily@09:00',
    sessionId: 'sess-1',
    owner: 'builtin:goal',
    ownerKey: goalId,
    now: 1000,
    ...over,
  });

  it('putOwned 新插：归属三列落库 + enabled 缺省 1（挂钟生而走钟）', () => {
    db.putOwned(ownedJob('g1'));
    const job = db.getOwned('builtin:goal', 'g1')!;
    expect(job).toBeDefined();
    expect(job.owner).toBe('builtin:goal');
    expect(job.ownerKey).toBe('g1');
    expect(job.enabled).toBe(true);
    expect(job.schedule).toBe('daily@09:00');
    expect(job.sessionId).toBe('sess-1');
  });

  it('putOwned 重挂 = 同名覆盖：prompt/schedule/session_id 刷新 + enabled 复活 + 触发史保留', () => {
    db.putOwned(ownedJob('g1'));
    // 触发史：模拟一次抢占推进 last_run_at（重挂不应重置）
    db.reserveRun('goal-g1', 2000, 'scheduled');
    // 停摆（enabled=0）后重挂——resume 路的真实序
    db.setOwnedEnabled('builtin:goal', 'g1', false, 2500);
    expect(db.getOwned('builtin:goal', 'g1')!.enabled).toBe(false);

    db.putOwned(
      ownedJob('g1', { prompt: '目标：g1（重挂）', schedule: 'daily@21:00', sessionId: 'sess-2', now: 3000 }),
    );
    const job = db.getOwned('builtin:goal', 'g1')!;
    expect(job.prompt).toBe('目标：g1（重挂）');
    expect(job.schedule).toBe('daily@21:00');
    expect(job.sessionId).toBe('sess-2');
    expect(job.enabled).toBe(true); // 复活
    expect(job.lastRunAt).toBe(2000); // 触发史保留（重挂不是重置）
    expect(job.createdAt).toBe(1000); // 同行延续
    expect(job.updatedAt).toBe(3000);
  });

  it('【回归锁 遗漏大扫 20260904-c 刀A】putOwned 名冲突拒：同名异主行不覆写——修前静默吞用户行（prompt 丢失/触发史继承污染）', () => {
    // 用户行先占名 goal-g1（/tick add 同路——owner NULL）
    db.add('goal-g1', '我的手动任务', 1000, 'daily@08:00');
    const out = db.putOwned(ownedJob('g1', { prompt: '续跑快照', now: 2000 }));
    // 修前：void 返回 + ON CONFLICT 覆写——用户行被吞（owner 变 builtin:goal）
    expect(out).toBe('conflict');
    const row = db.get('goal-g1')!;
    expect(row.owner).toBeNull();
    expect(row.prompt).toBe('我的手动任务');
  });

  it('putOwned 同 owner 重挂不受冲突守卫影响（名约定内的正常覆盖路径）', () => {
    db.putOwned(ownedJob('g1'));
    const out = db.putOwned(ownedJob('g1', { prompt: '重挂', now: 2000 }));
    expect(out).toBe('written');
    expect(db.get('goal-g1')!.prompt).toBe('重挂');
  });

  it('setOwnedEnabled：生命周期位翻转（终态/降级 0 · resume 1）——行留史不删', () => {
    db.putOwned(ownedJob('g1'));
    db.setOwnedEnabled('builtin:goal', 'g1', false, 2000);
    const stopped = db.getOwned('builtin:goal', 'g1')!;
    expect(stopped.enabled).toBe(false);
    expect(stopped.updatedAt).toBe(2000);
    db.setOwnedEnabled('builtin:goal', 'g1', true, 3000);
    expect(db.getOwned('builtin:goal', 'g1')!.enabled).toBe(true);
  });

  it('setOwnedEnabled 无行命中 = 静默 no-op（未挂过钟的 goal 非错误）', () => {
    expect(() => db.setOwnedEnabled('builtin:goal', 'ghost', false, 1000)).not.toThrow();
  });

  it('removeOwned：删行返回行名（OS 注销联动消费）/ 无行 null', () => {
    expect(db.removeOwned('builtin:goal', 'g1')).toBeNull();
    db.putOwned(ownedJob('g1'));
    expect(db.removeOwned('builtin:goal', 'g1')).toBe('goal-g1');
    expect(db.getOwned('builtin:goal', 'g1')).toBeUndefined();
    expect(db.get('goal-g1')).toBeUndefined();
  });

  it('getOwned：同归属多行（手编库防御）取 updated_at 最新', () => {
    db.putOwned(ownedJob('g1', { now: 1000 }));
    // 手编库才可能出现的同 owner+key 异名行——绕 putOwned 直接 add + 不可达？
    // add 不写归属列；用第二行 putOwned 同 key 异名模拟（名约定破坏场景）
    db.putOwned(ownedJob('g1', { name: 'goal-g1-legacy', now: 2000 }));
    const latest = db.getOwned('builtin:goal', 'g1')!;
    expect(latest.name).toBe('goal-g1-legacy'); // updated_at 新者胜
  });

  it('存量行（v7/v9 老路 add）读出：owner/ownerKey NULL + enabled 缺省 true（不伤老任务）', () => {
    db.add('legacy-job', '老任务', 100);
    const job = db.get('legacy-job')!;
    expect(job.owner).toBeNull();
    expect(job.ownerKey).toBeNull();
    expect(job.enabled).toBe(true);
  });
});
