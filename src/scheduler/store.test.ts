/**
 * L3 scheduler — jobs 表 DAO 集成测试（JobsStore，经 persist 迁移框架建表后
 * 真库 :memory: SQLite，无 mock——goal 表族同款）。逐方法语义 + **执行前抢占
 * 三态**（reserve-then-run：reserved/missing/lost-race——冷读 #1 裁决的
 * 护栏语义在此锁死）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import { JobsStore, SCHEDULER_MIGRATION, JOB_NAME_PATTERN } from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移一次到位后交 DAO） */
let store: Store;
let db: JobsStore;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: [SCHEDULER_MIGRATION] });
  db = new JobsStore(store.connection);
});

describe('add / get / list / remove：任务行 CRUD', () => {
  it('新插：全字段落库（cwd/schedule/lastRunAt 为 NULL——第二刀预留位）', () => {
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

describe('reserveRun：执行前抢占（reserve-then-run 三态）', () => {
  it('任务不存在 → missing', () => {
    expect(db.reserveRun('ghost', 1000)).toBe('missing');
  });

  it('首次抢占 reserved：last_run_at NULL → 推进 + updated_at 跟进', () => {
    db.add('a', 'p', 100);
    expect(db.reserveRun('a', 5000)).toBe('reserved');
    const job = db.get('a')!;
    expect(job.lastRunAt).toBe(5000);
    expect(job.updatedAt).toBe(5000);
  });

  it('再次手动触发合法：新 last_run_at 为新比对键（手动连跑两次是用户裁量）', () => {
    db.add('a', 'p', 100);
    expect(db.reserveRun('a', 1000)).toBe('reserved');
    expect(db.reserveRun('a', 2000)).toBe('reserved'); // get 拿到 1000 → 条件更新成功
    expect(db.get('a')!.lastRunAt).toBe(2000);
  });

  it('lost-race：读值后他方抢先（旧比对键条件更新 changes=0 让路）', () => {
    db.add('a', 'p', 100);
    // 编排双进程竞写：进程 B 先读行（拿到 NULL 比对键）……
    const expected = db.get('a')!.lastRunAt; // null
    // ……进程 A 抢先抢占成功……
    expect(db.reserveRun('a', 1111)).toBe('reserved');
    // ……进程 B 携旧比对键条件更新——changes=0 让路（token 未花，正确）
    const changes = store.connection
      .prepare(`UPDATE jobs SET last_run_at = ?, updated_at = ? WHERE name = ? AND last_run_at IS ?`)
      .run(2222, 2222, 'a', expected).changes;
    expect(changes).toBe(0);
    expect(db.get('a')!.lastRunAt).toBe(1111); // A 的推进不被 B 覆写
  });
});
