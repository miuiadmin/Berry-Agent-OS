/**
 * L1 session — llm/usage 底账桶归一测试（P1-5 修偏，会话篇 §1.1 全桶入账）。
 *
 * 修偏前 complete/前台 loop/结算折叠三写点各自手写 `{input,output}`——cache 桶
 * 被裁，读侧 /usage 面板（四桶总和）与底账长期两张皮（挖矿 B3）。归一函数成为
 * 单一事实源后，裁桶在这三处结构性不可能再发生。
 */
import { describe, expect, it } from 'vitest';
import { ledgerModel, usageLedgerBuckets } from './event-types.js';

describe('usageLedgerBuckets（底账桶归一）', () => {
  it('四必填桶直拷；可选桶（cacheWrite1h/reasoning）上报才落、缺省省略字段', () => {
    // 供应商不报拆分桶的最小形态（pi-ai Usage 四必填）
    expect(usageLedgerBuckets({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 })).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // Anthropic 形态：cacheWrite1h + reasoning 双上报
    expect(
      usageLedgerBuckets({
        input: 10,
        output: 5,
        cacheRead: 7,
        cacheWrite: 2,
        cacheWrite1h: 1,
        reasoning: 3,
        totalTokens: 17,
      }),
    ).toEqual({ input: 10, output: 5, cacheRead: 7, cacheWrite: 2, cacheWrite1h: 1, reasoning: 3 });
  });

  it('派生与折算桶滤除：totalTokens/cost 不入账（折算归投影——价格表更新不回改历史）', () => {
    const buckets = usageLedgerBuckets({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { total: 0.02 },
    });
    expect(buckets).not.toHaveProperty('totalTokens');
    expect(buckets).not.toHaveProperty('cost');
  });
});

describe('ledgerModel（底账 model 归一）', () => {
  it('实录优先：provider+model 拼全形；只带 model 落半形；缺则请求兜底、再缺 unknown', () => {
    // 实录全形（pi 消息恒带 provider+model——生产路径常态）
    expect(ledgerModel({ provider: 'anthropic', model: 'claude-sonnet-5' }, 'anthropic/default')).toBe(
      'anthropic/claude-sonnet-5',
    );
    // 半形（scripted 消息只带 model——测试/合成路径）
    expect(ledgerModel({ model: 'm1' }, 'faux/m1')).toBe('m1');
    // 请求兜底（消息不带模型元数据）
    expect(ledgerModel({}, 'faux/m1')).toBe('faux/m1');
    // 终极兜底
    expect(ledgerModel({})).toBe('unknown');
  });
});
