/**
 * L3 compaction 单元测试（策略纯函数——判阈/区间规划/防抖/冷却/预算/提示词）。
 * 件本体编排（plugin.ts）的集成测见 plugin.test.ts；本文件只锁纯逻辑半边。
 */

import { describe, expect, it } from 'vitest';
import type { ProjectedMessage } from '../session/derive.js';
import {
  SUMMARY_PREFIX,
  buildSummaryPrompt,
  evaluateDebounce,
  evaluateThreshold,
  inCooldown,
  planSegment,
  summaryBudgetFor,
} from './policy.js';

/** 造一条 user 型投影消息（seq 锚可控） */
function userMsg(seq: number, content = 'x'): ProjectedMessage {
  return { type: 'user', seq, content };
}

/* ---------------- 判阈 ---------------- */

describe('evaluateThreshold（真 token 优先 + 粗估兜底）', () => {
  it('有主 loop usage 笔：过阈触发，basis=usage', () => {
    const v = evaluateThreshold({
      lastLoopUsageInput: 120_000,
      contextWindow: 200_000,
      projectedChars: 0,
      thresholdRatio: 0.5,
      fallbackWindowTokens: 200_000,
    });
    expect(v.fire).toBe(true);
    expect(v.basis).toBe('usage');
    expect(v.estTokens).toBe(120_000);
    expect(v.effectiveWindow).toBe(200_000);
  });

  it('有 usage 笔但未过阈：不触发（粗估再大也不抢判——真值优先）', () => {
    const v = evaluateThreshold({
      lastLoopUsageInput: 99_999,
      contextWindow: 200_000,
      projectedChars: 10_000_000,
      thresholdRatio: 0.5,
      fallbackWindowTokens: 200_000,
    });
    expect(v.fire).toBe(false);
    expect(v.basis).toBe('usage');
  });

  it('无 usage 笔：粗估 chars/4 过阈触发，basis=estimate', () => {
    const v = evaluateThreshold({
      lastLoopUsageInput: null,
      contextWindow: 200_000,
      projectedChars: 4 * 100_001, // 100_001 tokens > 100_000 阈
      thresholdRatio: 0.5,
      fallbackWindowTokens: 200_000,
    });
    expect(v.fire).toBe(true);
    expect(v.basis).toBe('estimate');
    expect(v.estTokens).toBe(100_001);
  });

  it('窗口未知：fallbackWindowTokens 兜底', () => {
    const v = evaluateThreshold({
      lastLoopUsageInput: 150_000,
      contextWindow: undefined,
      projectedChars: 0,
      thresholdRatio: 0.5,
      fallbackWindowTokens: 200_000,
    });
    expect(v.effectiveWindow).toBe(200_000);
    expect(v.fire).toBe(true);
  });
});

/* ---------------- 区间规划 ---------------- */

describe('planSegment（head 保护 + tail 保留 + 中段 ≥1）', () => {
  it('最小条数不足返回 null（head 1 + tail N + 中段 ≥1 放不下即不压）', () => {
    // length < 2+tailKeep 即 null：7 < 8（tailKeep6）、8 < 9（tailKeep7）
    expect(
      planSegment(
        Array.from({ length: 7 }, (_, i) => userMsg(i)),
        6,
      ),
    ).toBeNull();
    expect(
      planSegment(
        Array.from({ length: 8 }, (_, i) => userMsg(i)),
        7,
      ),
    ).toBeNull();
    // 恰好放得下（8 条 tailKeep6 = head1+中段1+tail6）不返回 null
    expect(
      planSegment(
        Array.from({ length: 8 }, (_, i) => userMsg(i)),
        6,
      ),
    ).not.toBeNull();
  });

  it('恰好 head 1 + tail N + 中段 1：切界 = head 锚+1 到 tail 最小锚-1', () => {
    // seq 0..9（10 条），tailKeep=6：head=seq0，tail 起 seq4，中段 seq1..3
    const msgs = Array.from({ length: 10 }, (_, i) => userMsg(i));
    const plan = planSegment(msgs, 6);
    expect(plan).not.toBeNull();
    expect(plan!.start).toBe(1);
    expect(plan!.end).toBe(3);
    expect(plan!.occludedMessages).toBe(3);
    expect(plan!.occludedChars).toBeGreaterThan(0);
  });

  it('seq 有空洞（log-only 事件不产消息）：按锚 seq 开区间过滤，闭包整段', () => {
    // 消息锚 seq = 0,5,10,15,20,25,30,35（8 条），tailKeep=2：head=0，tail 起
    // 倒数第二条 seq30；中段 = 锚 ∈ (0,30) 开区间 → 5/10/15/20/25 五条；区间 [1,29]
    const seqs = [0, 5, 10, 15, 20, 25, 30, 35];
    const plan = planSegment(
      seqs.map((s) => userMsg(s)),
      2,
    );
    expect(plan!.start).toBe(1);
    expect(plan!.end).toBe(29);
    expect(plan!.occludedMessages).toBe(5);
  });

  it('投影空数组安全返回 null', () => {
    expect(planSegment([], 6)).toBeNull();
  });
});

/* ---------------- 防抖 ---------------- */

describe('evaluateDebounce（连续节省 <10% 两次即 suppress）', () => {
  it('单轮节省 <10%：计数 +1，不 suppress', () => {
    const v = evaluateDebounce({ beforeInput: 100_000, afterInput: 95_000, consecutiveLowSavings: 0 });
    expect(v.nextCount).toBe(1);
    expect(v.suppress).toBe(false);
  });

  it('连续第二次 <10%：suppress 置位', () => {
    const v = evaluateDebounce({ beforeInput: 100_000, afterInput: 91_000, consecutiveLowSavings: 1 });
    expect(v.nextCount).toBe(2);
    expect(v.suppress).toBe(true);
  });

  it('节省 ≥10%：计数清零', () => {
    const v = evaluateDebounce({ beforeInput: 100_000, afterInput: 50_000, consecutiveLowSavings: 1 });
    expect(v.nextCount).toBe(0);
    expect(v.suppress).toBe(false);
  });

  it('after ≥ before（压缩无效）：按节省 0 计入', () => {
    const v = evaluateDebounce({ beforeInput: 100_000, afterInput: 100_000, consecutiveLowSavings: 1 });
    expect(v.nextCount).toBe(2);
    expect(v.suppress).toBe(true);
  });
});

/* ---------------- 冷却 ---------------- */

describe('inCooldown（durable derive——失败事实在日志）', () => {
  it('失败时间在冷却窗内：true', () => {
    expect(inCooldown(1_000_000, 1_000_000 + 599_999, 600_000)).toBe(true);
  });

  it('出窗：false；从未失败（null）：false', () => {
    expect(inCooldown(1_000_000, 1_000_000 + 600_000, 600_000)).toBe(false);
    expect(inCooldown(null, 1_000_000, 600_000)).toBe(false);
  });
});

/* ---------------- 摘要预算与提示词 ---------------- */

describe('summaryBudgetFor（三参钳制）', () => {
  const budget = { ratio: 0.2, min: 2000, max: 12_000 };
  it('中段：occludedChars/4 × ratio', () => {
    // 400_000 chars → 100_000 tokens × 0.2 = 20_000 → 钳到 max 12_000
    expect(summaryBudgetFor(400_000, budget)).toBe(12_000);
  });

  it('下限钳制：短内容不压过狠', () => {
    expect(summaryBudgetFor(1_000, budget)).toBe(2000);
  });

  it('区间内直取', () => {
    // 100_000 chars → 25_000 × 0.2 = 5_000
    expect(summaryBudgetFor(100_000, budget)).toBe(5000);
  });
});

describe('buildSummaryPrompt（五段模板 + 迭代链）', () => {
  const msgs: ProjectedMessage[] = [
    { type: 'user', seq: 1, content: '帮我看下 b.ts' },
    { type: 'assistant', seq: 2, content: [], toolCalls: [] },
  ];

  it('五段结构词 + 被压缩内容 + 预算数字都在', () => {
    const p = buildSummaryPrompt(msgs, null, 3000);
    for (const section of ['Goal', 'Progress', 'Decisions', 'Resolved', 'Pending']) {
      expect(p).toContain(section);
    }
    expect(p).toContain('3000');
    expect(p).toContain('b.ts');
  });

  it('前次摘要并入（迭代链——信息不丢）', () => {
    const p = buildSummaryPrompt(msgs, '旧摘要：目标是重构存储层', 3000);
    expect(p).toContain('旧摘要：目标是重构存储层');
  });

  it('SUMMARY_PREFIX 标记形如框架句式前缀', () => {
    expect(SUMMARY_PREFIX).toBe('[COMPACTION-SUMMARY]');
  });
});
