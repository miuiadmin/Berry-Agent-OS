/**
 * L3 obs — 自管库面测试（迁移幂等 / 增量往返 / 水印 MAX 合并 / 查询白名单；
 * :memory: 库——零落盘）。
 */
import { existsSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAppSqliteFace } from '../persist/index.js';
import { openRollupStore } from './store.js';
import type { BucketDelta } from './rollup.js';

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/** 临时库路径（真实文件——验证 0600/迁移落盘；目录随 tmpdir 清理） */
const tmpDb = (): string => join(realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-store-'))), 'rollup.db');

describe('obs 自管库面', () => {
  it('迁移幂等：同库二次开库零异常（user_version 私有链）', () => {
    const path = tmpDb();
    const first = openRollupStore(path);
    first.close();
    // 0600 追打断言（契约篇 §6.9 自管库段——app-sqlite face 内执行；umask 无关）
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = openRollupStore(path); // 重开 = user_version 已 1，零补跑
    const rows = second.query({ metric: 'turn', fromMs: T0 - 1, toMs: T0 + 1, groupBy: [] });
    expect(rows).toHaveLength(1); // 空表总计行（SQL 无 GROUP BY 的零值行——语义正确）
    expect(rows[0]?.measures['turns']).toBe(0);
    second.close();
  });

  it('增量往返：apply → query 聚合 + 同桶二次 apply 累加', () => {
    const store = openRollupStore(':memory:');
    const delta: BucketDelta = { table: 'turn', hourTs: T0, dims: ['chat'], cols: { turns: 1, user_msgs: 2 } };
    store.apply([delta, { ...delta, dims: ['chat'], cols: { turns: 3 } }]);
    const rows = store.query({ metric: 'turn', fromMs: T0, toMs: T0, groupBy: [] });
    expect(rows[0]?.measures).toMatchObject({ turns: 4, user_msgs: 2 });
    store.close();
  });

  it('dur_ms_max 单调水印：MAX 合并不随低值回落', () => {
    const store = openRollupStore(':memory:');
    store.apply([
      { table: 'tool', hourTs: T0, dims: ['chat', 'bash'], cols: { calls: 1, dur_ms_sum: 9_000, dur_ms_max: 9_000 } },
    ]);
    store.apply([
      { table: 'tool', hourTs: T0, dims: ['chat', 'bash'], cols: { calls: 1, dur_ms_sum: 100, dur_ms_max: 100 } },
    ]);
    const rows = store.query({ metric: 'tool', fromMs: T0, toMs: T0, groupBy: [] });
    expect(rows[0]?.measures).toMatchObject({ calls: 2, dur_ms_sum: 9_100, dur_ms_max: 9_000 });
    store.close();
  });

  it('查询白名单：非法 groupBy 维度抛错；groupBy hour 生效', () => {
    const store = openRollupStore(':memory:');
    store.apply([{ table: 'llm', hourTs: T0, dims: ['chat', 'm1', 'foreground'], cols: { calls: 1 } }]);
    expect(() => store.query({ metric: 'llm', fromMs: T0, toMs: T0, groupBy: ['bogus'] })).toThrow(/非法维度/);
    const rows = store.query({ metric: 'llm', fromMs: T0, toMs: T0, groupBy: ['hour'] });
    expect(rows[0]?.dims['hour']).toBe(T0);
    store.close();
  });

  it('遮蔽回退落库：负增量精确回退已计行（压缩后不双计的库面半边）', () => {
    const store = openRollupStore(':memory:');
    store.apply([{ table: 'llm', hourTs: T0, dims: ['chat', 'm', 'foreground'], cols: { calls: 1, tokens_in: 10 } }]);
    store.apply([{ table: 'llm', hourTs: T0, dims: ['chat', 'm', 'foreground'], cols: { calls: -1, tokens_in: -10 } }]);
    const rows = store.query({ metric: 'llm', fromMs: T0, toMs: T0, groupBy: [] });
    expect(rows[0]?.measures).toMatchObject({ calls: 0, tokens_in: 0 });
    store.close();
  });

  it('v2 扩列迁移（基建大扫 #13/#26/#50）：llm +exhausted/dur_ms_sum/dur_ms_max、turn +turn_failures/dur_ms_sum/dur_ms_max；user_version=2', () => {
    const path = tmpDb();
    openRollupStore(path).close();
    // raw 句柄经 persist 正路 face 取（better-sqlite3 裸导入仅 persist 允许）
    const raw = createAppSqliteFace().openDatabase(path);
    const cols = (table: string): string[] =>
      (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('llm_rollup_hour')).toEqual(expect.arrayContaining(['exhausted', 'dur_ms_sum', 'dur_ms_max']));
    expect(cols('turn_rollup_hour')).toEqual(expect.arrayContaining(['turn_failures', 'dur_ms_sum', 'dur_ms_max']));
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    raw.close();
  });

  it('llm/turn 新列往返 + dur_ms_max MAX 合并（与 tool 表同机制跨到两表）', () => {
    const store = openRollupStore(':memory:');
    store.apply([
      {
        table: 'llm',
        hourTs: T0,
        dims: ['chat', 'm', 'foreground'],
        cols: { calls: 1, dur_ms_sum: 900, dur_ms_max: 900 },
      },
    ]);
    store.apply([
      {
        table: 'llm',
        hourTs: T0,
        dims: ['chat', 'm', 'foreground'],
        cols: { calls: 1, exhausted: 1, dur_ms_sum: 100, dur_ms_max: 100 },
      },
    ]);
    const llm = store.query({ metric: 'llm', fromMs: T0, toMs: T0, groupBy: [] })[0]!.measures;
    expect(llm).toMatchObject({ calls: 2, exhausted: 1, dur_ms_sum: 1_000, dur_ms_max: 900 });
    store.apply([
      {
        table: 'turn',
        hourTs: T0,
        dims: ['chat'],
        cols: { turns: 1, turn_failures: 1, dur_ms_sum: 500, dur_ms_max: 500 },
      },
    ]);
    const turn = store.query({ metric: 'turn', fromMs: T0, toMs: T0, groupBy: [] })[0]!.measures;
    expect(turn).toMatchObject({ turns: 1, turn_failures: 1, dur_ms_sum: 500, dur_ms_max: 500 });
    store.close();
  });
});

describe('obs 自管库面：复盘 20260901 T-2/R-3 开库编舞回归锁', () => {
  it('R-3 半迁移残留自愈：表已建而 user_version 归零（崩溃残留）——重开不炸（IF NOT EXISTS 幂等）', () => {
    const path = tmpDb();
    const first = openRollupStore(path);
    first.close();
    // 模拟迁移事务外残留：表已在、user_version 被归零（首开 DDL 后、版本回写前崩溃）
    // （raw 句柄经 persist 正路 face 取——better-sqlite3 裸导入仅 persist 允许）
    const residue = createAppSqliteFace().openDatabase(path);
    residue.pragma('user_version = 0');
    residue.close();
    // HEAD：版本 0 → 补跑裸 CREATE TABLE → table already exists 崩——修复后 IF NOT EXISTS 自愈
    const healed = openRollupStore(path);
    const rows = healed.query({ metric: 'turn', fromMs: T0 - 1, toMs: T0 + 1, groupBy: [] });
    expect(rows).toHaveLength(1);
    healed.close();
  });

  it('T-2 跨进程写锁下的开库：非 WAL 库 + 他进程持写锁——探测+退避后响亮抛（不瞬时崩）', async () => {
    const path = tmpDb();
    // 子进程：建库（DELETE 模式）+ 持写事务 2s——模拟 daemon 常驻写、tick 子进程冷开
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const Database = require('better-sqlite3');", // module.exports 即构造器（default 导出形态）
          'const db = new Database(process.env.LOCK_DB);',
          "db.pragma('busy_timeout = 500');",
          "db.exec('CREATE TABLE _hold(x)');",
          "db.exec('BEGIN IMMEDIATE');",
          "db.prepare('INSERT INTO _hold VALUES (1)').run();",
          'setTimeout(() => { db.close(); process.exit(0); }, 2000);',
        ].join('\n'),
      ],
      { env: { ...process.env, LOCK_DB: path } },
    );
    // 等子进程建库并持锁（文件出现 + 短窗让 BEGIN IMMEDIATE 落地）
    while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const started = performance.now();
    // HEAD：WAL 切换先行（锁通道不吃 busy_timeout）→ 持锁即抛（~0ms）；
    // 修复后：busy_timeout 最先 + 幂等探测 + 5→15→45→135ms 退避（≥200ms 证据）后响亮抛
    expect(() => openRollupStore(path)).toThrow(/locked/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    await new Promise((resolve) => child.on('exit', resolve));
  });

  it('T-2 幂等探测：已 WAL 库 + 他连接持写事务——重开零切换需求（读侧零锁）', () => {
    const path = tmpDb();
    openRollupStore(path).close(); // 首开：WAL 已立
    // 同进程第二连接持写事务跨整个重开调用（单线程无释放窗）
    const holder = createAppSqliteFace().openDatabase(path);
    holder.pragma('busy_timeout = 100');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE alerts SET enabled = enabled').run();
    // 探测读 journal_mode = wal → 跳过切换 → 开库成功（版本已 1 零迁移）
    const second = openRollupStore(path);
    const rows = second.query({ metric: 'turn', fromMs: T0 - 1, toMs: T0 + 1, groupBy: [] });
    expect(rows).toHaveLength(1);
    second.close();
    holder.exec('COMMIT');
    holder.close();
  });

  it('#17 busyTimeoutMs 注入位：50ms 档撞锁即抛——不真等缺省 5s（T-1 降档的库面半边）', () => {
    const path = tmpDb();
    const store = openRollupStore(path, { busyTimeoutMs: 50 });
    store.apply([{ table: 'turn', hourTs: T0, dims: ['chat'], cols: { turns: 1 } }]);
    // 同进程他连接持写事务（WAL 已立——开库零锁冲突，撞点在 apply 写事务）
    const holder = createAppSqliteFace().openDatabase(path);
    holder.pragma('busy_timeout = 100');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE alerts SET enabled = enabled').run();
    const started = performance.now();
    expect(() => store.apply([{ table: 'turn', hourTs: T0 + 3_600_000, dims: ['chat'], cols: { turns: 1 } }])).toThrow(
      /locked/,
    );
    const elapsed = performance.now() - started;
    holder.exec('COMMIT');
    holder.close();
    store.close();
    // 50ms 档生效：远低于缺省 5000ms（2s 判线留慢机裕度——修偏前 ~5s 必红）
    expect(elapsed).toBeLessThan(2_000);
  });
});
