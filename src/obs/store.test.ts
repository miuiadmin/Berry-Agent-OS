/**
 * L3 obs — 自管库面测试（迁移幂等 / 增量往返 / 水印 MAX 合并 / 查询白名单；
 * :memory: 库——零落盘）。
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
