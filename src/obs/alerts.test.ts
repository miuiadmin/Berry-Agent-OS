/**
 * L3 obs — 刀二告警面回归锁（契约篇 §6.9：阈值/冷却/恢复三态 + CRUD + metric
 * 闭集 + 内联执法同事务语义；:memory: 库）。末段两测是文件库形态（#1 第二连接
 * 读提交可见性 / #2 边车 0600 物化）——遗漏大扫 20260902。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppSqliteFace } from '../persist/index.js';
import { openRollupStore, parseAlertMetric } from './store.js';
import type { BucketDelta } from './rollup.js';

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/** 造一条 llm 增量（tokens_in = n） */
const llmDelta = (tokensIn: number): BucketDelta => ({
  table: 'llm',
  hourTs: T0,
  dims: ['chat', 'm1', 'foreground'],
  cols: { calls: 1, tokens_in: tokensIn },
});

describe('obs 告警面：metric 闭集与 CRUD', () => {
  it('parseAlertMetric：四表度量列 + 水印列合法；坏表/坏列/无点拒绝', () => {
    expect(parseAlertMetric('llm.tokens_in')).toEqual({ table: 'llm', column: 'tokens_in' });
    expect(parseAlertMetric('tool.dur_ms_max')).toEqual({ table: 'tool', column: 'dur_ms_max' });
    expect(parseAlertMetric('turn.turns')).toEqual({ table: 'turn', column: 'turns' });
    expect(parseAlertMetric('approval.unavailable')).toEqual({ table: 'approval', column: 'unavailable' });
    expect(parseAlertMetric('llm.bogus')).toBeUndefined();
    expect(parseAlertMetric('alerts.metric')).toBeUndefined();
    expect(parseAlertMetric('nope')).toBeUndefined();
  });

  it('CRUD 往返：add 缺省 enabled=true 窗 24h 冷却 60min；list/rm/enable/disable', () => {
    const store = openRollupStore(':memory:');
    const rule = store.addAlert({
      metric: 'llm.calls',
      agg: 'sum',
      op: '>',
      threshold: 10,
      windowHours: 12,
      cooldownMin: 5,
    });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.enabled).toBe(true); // 缺省启用
    expect(store.listAlerts()).toHaveLength(1);
    expect(store.setAlertEnabled(rule.id, false)).toBe(true);
    expect(store.listAlerts()[0]!.enabled).toBe(false);
    expect(store.removeAlert(rule.id)).toBe(true);
    expect(store.listAlerts()).toHaveLength(0);
    expect(store.removeAlert(rule.id)).toBe(false); // 不存在
    store.close();
  });

  it('add 校验拒绝：坏 metric / 坏 agg / 坏 op / 窗 0 / 冷却负', () => {
    const store = openRollupStore(':memory:');
    expect(() =>
      store.addAlert({ metric: 'llm.bogus', agg: 'sum', op: '>', threshold: 1, windowHours: 1, cooldownMin: 1 }),
    ).toThrow(/非法/);
    expect(() =>
      store.addAlert({
        metric: 'llm.calls',
        agg: 'median',
        op: '>',
        threshold: 1,
        windowHours: 1,
        cooldownMin: 1,
      } as never),
    ).toThrow(/agg/);
    expect(() =>
      store.addAlert({
        metric: 'llm.calls',
        agg: 'sum',
        op: '=',
        threshold: 1,
        windowHours: 1,
        cooldownMin: 1,
      } as never),
    ).toThrow(/op/);
    expect(() =>
      store.addAlert({ metric: 'llm.calls', agg: 'sum', op: '>', threshold: 1, windowHours: 0, cooldownMin: 1 }),
    ).toThrow(/window/);
    expect(() =>
      store.addAlert({ metric: 'llm.calls', agg: 'sum', op: '>', threshold: 1, windowHours: 1, cooldownMin: -1 }),
    ).toThrow(/cooldown/);
    store.close();
  });
});

describe('obs 告警面：内联执法三态（阈值 / 冷却 / 恢复）', () => {
  it('阈值触发：窗口聚合过阈 → 回调带实测值 + last_fired_at 回写', () => {
    const store = openRollupStore(':memory:');
    store.addAlert({ metric: 'llm.tokens_in', agg: 'sum', op: '>=', threshold: 100, windowHours: 24, cooldownMin: 60 });
    const fired: Array<{ metric: string; value: number }> = [];
    store.apply([llmDelta(150)], (fire) => fired.push({ metric: fire.rule.metric, value: fire.value }));
    expect(fired).toEqual([{ metric: 'llm.tokens_in', value: 150 }]); // 实测值 = 窗口合计
    expect(store.listAlerts()[0]!.lastFiredAt).not.toBeNull(); // 回写在同事务
    store.close();
  });

  it('未过阈不触发；后续过阈触发（恢复→再触发按冷却判）', () => {
    const store = openRollupStore(':memory:');
    store.addAlert({ metric: 'llm.tokens_in', agg: 'sum', op: '>', threshold: 500, windowHours: 24, cooldownMin: 60 });
    const fired: number[] = [];
    store.apply([llmDelta(100)], () => fired.push(1)); // 未过阈
    expect(fired).toHaveLength(0);
    store.apply([llmDelta(450)], (fire) => fired.push(fire.value)); // 累计 550 过阈
    expect(fired).toEqual([550]);
    store.close();
  });

  it('冷却：触发后窗口内再 apply 不重触（同值过阈）；冷却 0 = 每 flush 可重触', () => {
    const store = openRollupStore(':memory:');
    // 冷却 60min：第二次 apply（同毫秒窗内）不重触
    store.addAlert({ metric: 'llm.tokens_in', agg: 'sum', op: '>', threshold: 50, windowHours: 24, cooldownMin: 60 });
    let count = 0;
    store.apply([llmDelta(100)], () => (count += 1));
    store.apply([llmDelta(100)], () => (count += 1)); // 冷却窗内——不重触
    expect(count).toBe(1);
    store.close();
    // 冷却 0：每次 flush 过阈即发（连续通知形态——用户显式选的）
    const store2 = openRollupStore(':memory:');
    store2.addAlert({ metric: 'llm.tokens_in', agg: 'sum', op: '>', threshold: 50, windowHours: 24, cooldownMin: 0 });
    let count2 = 0;
    store2.apply([llmDelta(100)], () => (count2 += 1));
    store2.apply([llmDelta(100)], () => (count2 += 1));
    expect(count2).toBe(2);
    store2.close();
  });

  it('停用规则不执法；未触达表上的规则不评（touched 优化语义）', () => {
    const store = openRollupStore(':memory:');
    const disabled = store.addAlert({
      metric: 'llm.tokens_in',
      agg: 'sum',
      op: '>',
      threshold: 1,
      windowHours: 24,
      cooldownMin: 60,
    });
    store.setAlertEnabled(disabled.id, false);
    // tool 表触达——llm 规则不评（也未启用了，双保险零回调）
    const toolDelta: BucketDelta = {
      table: 'tool',
      hourTs: T0,
      dims: ['chat', 'bash'],
      cols: { calls: 1, failures: 1 },
    };
    let fired = 0;
    store.apply([toolDelta], () => (fired += 1));
    expect(fired).toBe(0);
    store.close();
  });

  it('agg=max 语义：窗口内小时桶最大值（非增量值）', () => {
    const store = openRollupStore(':memory:');
    store.addAlert({ metric: 'tool.failures', agg: 'max', op: '>=', threshold: 3, windowHours: 24, cooldownMin: 60 });
    const fired: number[] = [];
    // 两桶各 2 次失败（sum=4 / max=2）——max 口径不过阈 3
    const t1: BucketDelta = { table: 'tool', hourTs: T0, dims: ['a', 'x'], cols: { calls: 2, failures: 2 } };
    const t2: BucketDelta = {
      table: 'tool',
      hourTs: T0 + 3_600_000,
      dims: ['a', 'x'],
      cols: { calls: 2, failures: 2 },
    };
    store.apply([t1, t2], (fire) => fired.push(fire.value));
    expect(fired).toHaveLength(0); // max=2 < 3
    store.close();
  });
});

describe('obs 告警面：开库卫生与回调时点（遗漏大扫 20260902 #1/#2）', () => {
  it('#1 回调在事务提交后出膛：onAlert 内第二连接已可见 last_fired_at（WAL 隔离反证）', () => {
    // 修前形态：onAlert 在 store 事务内执行——同事务后续语句盘级错误回滚时，
    // 通知/留账已发生且无补偿（重复通知+重复留账）。本锁以 WAL 快照隔离做
    // 机器反证：回调若仍在事务内，第二连接读到的是提交前快照（last_fired_at
    // 为 null）；回调已在提交后，读到非 null。修前必红、修后恒绿。
    const dir = mkdtempSync(join(tmpdir(), 'obs-alert-timing-'));
    const dbPath = join(dir, 'rollup.db');
    const store = openRollupStore(dbPath);
    try {
      const rule = store.addAlert({
        metric: 'llm.tokens_in',
        agg: 'sum',
        op: '>=',
        threshold: 100,
        windowHours: 24,
        cooldownMin: 60,
      });
      let seenByOtherConn: number | null | undefined;
      store.apply([llmDelta(150)], () => {
        // 第二连接（官方件直连形态——与宿主 daemon 双开同面）读触发规则行
        const other = createAppSqliteFace().openDatabase(dbPath);
        try {
          const row = other.prepare('SELECT last_fired_at FROM alerts WHERE id = ?').get(rule.id) as
            | {
                last_fired_at: number | null;
              }
            | undefined;
          seenByOtherConn = row?.last_fired_at ?? null;
        } finally {
          other.close();
        }
      });
      // 回调确实出膛（不被本测试的探针吞掉），且第二连接读到已提交的冷却基准
      expect(typeof seenByOtherConn).toBe('number'); // null = 快照隔离下未提交（修前形态）
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#2 边车三件 0600 形状锁：首开与净关重开两形态（零写锁开库不变式另由 T-2 承担）', () => {
    // 形状锁（非红前回归锁——修前实测两形态边车已在场且 0600：首开由迁移写物化
    // + face 先 chmod 主文件、SQLite 建边车继承主文件权限；重开由 WAL 旗标库的
    // 读者〔user_version 读〕物化。#2 的暴露声称在接线路上不成立，落码是主库
    // 同款存在性 chmod 的平台差异兜底）。本锁钉住不变式防退化：两形态三件全在
    // 场全 0600；「开库不拿写锁」的行为差分由 store.test.ts T-2 锁承担（首版
    // 物化写事务方案即被 T-2 击退）。
    const dir = mkdtempSync(join(tmpdir(), 'obs-rollup-mode-'));
    const dbPath = join(dir, 'rollup.db');
    const assertThreeFiles = (phase: string) => {
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(existsSync(p), `${phase}：${p} 应在开库时刻在场`).toBe(true);
        expect(statSync(p).mode & 0o777, `${phase}：${p} 须 0600（缺省 umask 暴露窗）`).toBe(0o600);
      }
    };
    const store = openRollupStore(dbPath);
    try {
      assertThreeFiles('首开（迁移写已物化）');
    } finally {
      store.close();
    }
    // 净关即删边车（SQLite WAL 语义）——重开腿锁「读者物化」不退化
    const reopened = openRollupStore(dbPath);
    try {
      assertThreeFiles('净关重开（零写事务）');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
