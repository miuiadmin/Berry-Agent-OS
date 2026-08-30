/**
 * L3 goal — 轮间沉淀策略纯函数测试（summary.ts 全函数覆盖，零 IO）。
 *
 * 判阈（阈值比例 / 兜底窗）+ 区间规划（floor 收窄 / 最小条数 / head·tail
 * 保留 / 端序连续性）+ 预算三参钳制 + 提示词（objective 锚定转义 / 前次
 * 摘要并入 / 预算行 / 序列化段）+ 水位回填（goalId 过滤 / 流序后者胜 /
 * 水位 max / 缺席 undefined）。编排与落账半边在 app-summary.test.ts
 * （stub-harness 形态——mock 只停在模型层）。
 */

import { describe, expect, it } from 'vitest';
import {
  shouldSummarize,
  planSummarySegment,
  summaryBudgetFor,
  buildGoalSummaryPrompt,
  latestSummaryFromEvents,
  SUMMARY_THRESHOLD_RATIO,
  SUMMARY_FALLBACK_WINDOW_TOKENS,
  SUMMARY_TAIL_KEEP,
  type SummaryMessageView,
} from './summary.js';

/** 造一条投影 user 消息（seq 锚 + 任意内容——规划域只看 seq） */
function userMsg(seq: number, content = '推进'): SummaryMessageView {
  return { type: 'user', seq, content };
}

/** 造一段连续 seq 的消息列（count 条从 from 起——规划测试的标准素材） */
function seqMessages(from: number, count: number): SummaryMessageView[] {
  return Array.from({ length: count }, (_, i) => userMsg(from + i));
}

/** 直传转义器（测试提示词面——转义语义由 escapeXml 自测，此处直通看锚定） */
const identityEscape = (text: string): string => text;

describe('shouldSummarize：判阈（chars/4 ≥ window × ratio）', () => {
  it('窗口在场：恰在阈值上触发（200k 窗 × 0.5 = 100k tokens = 400k chars）', () => {
    const charsAtThreshold = 200_000 * 4 * SUMMARY_THRESHOLD_RATIO;
    expect(shouldSummarize({ contextWindow: 200_000, projectedChars: charsAtThreshold })).toBe(true);
    expect(shouldSummarize({ contextWindow: 200_000, projectedChars: charsAtThreshold - 8 })).toBe(false);
  });

  it('窗口缺席（目录无此模型）：走兜底 200k 同比例', () => {
    const charsAtFallback = SUMMARY_FALLBACK_WINDOW_TOKENS * 4 * SUMMARY_THRESHOLD_RATIO;
    expect(shouldSummarize({ contextWindow: undefined, projectedChars: charsAtFallback })).toBe(true);
    expect(shouldSummarize({ contextWindow: undefined, projectedChars: charsAtFallback - 8 })).toBe(false);
  });

  it('chars 上取整：非整除时 ceil 参与比较（395_999 chars → 99_000 tokens ≥ 99_000 触发）', () => {
    // 99_000 × 4 = 396_000 恰触发；395_999 → ceil(98_999.75) = 99_000 仍触发
    expect(shouldSummarize({ contextWindow: 198_000, projectedChars: 395_999 })).toBe(true);
  });
});

describe('planSummarySegment：区间规划（floor 收窄 + head/tail 保留）', () => {
  it('最小条数不足（< 2 + tailKeep）→ null', () => {
    expect(planSummarySegment(seqMessages(1, 2 + SUMMARY_TAIL_KEEP - 1), null)).toBeNull();
    expect(planSummarySegment(seqMessages(1, 2 + SUMMARY_TAIL_KEEP), null)).not.toBeNull();
  });

  it('段内布局：head 保首条 + tail 保末 6 条 + 中段全遮（seq 闭区间）', () => {
    // 10 条 seq 1..10：head=1 保留，tail=5..10 保留，沉淀区间 [2, 4]（3 条）
    const plan = planSummarySegment(seqMessages(1, 10), null)!;
    expect(plan.start).toBe(2);
    expect(plan.end).toBe(4);
    expect(plan.occludedMessages).toBe(3);
    expect(plan.occludedChars).toBe(JSON.stringify([userMsg(2), userMsg(3), userMsg(4)]).length);
  });

  it('floor 收窄：激活锚之前的旧会话史不进规划域（head = 锚后首条）', () => {
    // seq 1..4 是激活前旧史，5..14 是 goal 段：head=5，tail=9..14，沉淀 [6, 8]
    const messages = [...seqMessages(1, 4), ...seqMessages(5, 10)];
    const plan = planSummarySegment(messages, 5)!;
    expect(plan.start).toBe(6);
    expect(plan.end).toBe(8);
    expect(plan.occludedMessages).toBe(3);
  });

  it('floor=null（存量行不可考）→ 0 同款全域规划', () => {
    const plan = planSummarySegment(seqMessages(1, 10), null)!;
    expect(plan.start).toBe(2);
  });

  it('恰最小条数：中段恰 1 条（head 1 + 中段 1 + tail 6 = 8 条）', () => {
    const plan = planSummarySegment(seqMessages(1, 2 + SUMMARY_TAIL_KEEP), null)!;
    expect(plan.occludedMessages).toBe(1);
  });

  it('seq 不连续（稀疏锚）：tail 按位置取末 6 条非按 seq 邻接——端序按锚切', () => {
    // 域内 8 条 seq 1..7,100：tail 位置末 6 = seq 3,4,5,6,7,100 → 沉淀 [2, 2]
    const sparse = [...seqMessages(1, 7), userMsg(100)];
    const plan = planSummarySegment(sparse, 1)!;
    expect(plan.start).toBe(2);
    expect(plan.end).toBe(2);
    expect(plan.occludedMessages).toBe(1);
  });
});

describe('summaryBudgetFor：三参钳制（ratio × chars/4 → [min, max]）', () => {
  const budget = { ratio: 0.2, min: 2000, max: 12_000 };

  it('中段值：chars/4 × ratio 直取', () => {
    // 100_000 chars → 25_000 tokens × 0.2 = 5000
    expect(summaryBudgetFor(100_000, budget)).toBe(5000);
  });

  it('短内容压下限（min 兜底）', () => {
    expect(summaryBudgetFor(100, budget)).toBe(2000);
  });

  it('长内容压上限（max 封顶）', () => {
    expect(summaryBudgetFor(10_000_000, budget)).toBe(12_000);
  });

  it('恰在下限值：不误伤（est == min 直取）', () => {
    // 40_000 chars → 10_000 × 0.2 = 2000 = min
    expect(summaryBudgetFor(40_000, budget)).toBe(2000);
  });
});

describe('buildGoalSummaryPrompt：objective 锚定 + 五节 + 迭代合并', () => {
  const base = {
    objective: '把 goal 纵切落完',
    previousSummary: null as string | null,
    occludedMessages: [userMsg(2, '完成了状态机')] as readonly SummaryMessageView[],
    budgetTokens: 3000,
    escape: identityEscape,
  };

  it('objective 全文在场（锚定纪律）+ 五节词面 + 预算行 + 序列化段', () => {
    const prompt = buildGoalSummaryPrompt(base);
    expect(prompt).toContain('把 goal 纵切落完');
    expect(prompt).toContain('Goal');
    expect(prompt).toContain('Progress');
    expect(prompt).toContain('Decisions');
    expect(prompt).toContain('Resolved');
    expect(prompt).toContain('Pending');
    expect(prompt).toContain('3000 tokens');
    expect(prompt).toContain(JSON.stringify(base.occludedMessages));
  });

  it('objective 过转义器（用户数据非指令——escape 注入点真消费）', () => {
    let seen = '';
    buildGoalSummaryPrompt({ ...base, objective: 'RAW', escape: (t) => ((seen = t), 'ESCAPED') });
    expect(seen).toBe('RAW');
  });

  it('前次摘要并入（迭代更新——信息不丢条款在场）', () => {
    const prompt = buildGoalSummaryPrompt({ ...base, previousSummary: '前次：已完成状态机' });
    expect(prompt).toContain('前次：已完成状态机');
    expect(prompt).toContain('合并进新摘要');
  });

  it('首次沉淀（previousSummary null）：无并入段', () => {
    expect(buildGoalSummaryPrompt(base)).not.toContain('合并进新摘要');
  });
});

describe('latestSummaryFromEvents：水位回填（单事实源 = 事件流）', () => {
  /** 造一条 goal/summary 形载荷（字段缺失/异型由过滤用例自带） */
  const ev = (goalId: string, summarySeq: number, text = '摘要') => ({ data: { goalId, summarySeq, text } });

  it('无匹配事件 → undefined（无可回填）', () => {
    expect(latestSummaryFromEvents([], 'g1')).toBeUndefined();
    expect(latestSummaryFromEvents([ev('g2', 10)], 'g1')).toBeUndefined();
  });

  it('流序后者胜（append-only 日志序）', () => {
    const result = latestSummaryFromEvents([ev('g1', 10, '旧'), ev('g1', 20, '新')], 'g1')!;
    expect(result.summary).toBe('新');
    expect(result.summarySeq).toBe(20);
  });

  it('水位取 max（乱序流防御——低水位后到不回退）', () => {
    const result = latestSummaryFromEvents([ev('g1', 20, '高水位'), ev('g1', 10, '低水位后到')], 'g1')!;
    expect(result.summary).toBe('高水位');
    expect(result.summarySeq).toBe(20);
  });

  it('载荷异型（goalId 不符 / text 非串 / summarySeq 非数 / data 缺席）全跳过', () => {
    const events = [
      { data: { goalId: 'g1', summarySeq: 5 } }, // 缺 text
      { data: { goalId: 'g1', text: '序非数', summarySeq: 'x' } },
      { data: undefined },
      {},
      ev('g1', 8, '唯一合法'),
    ];
    const result = latestSummaryFromEvents(events, 'g1')!;
    expect(result.summary).toBe('唯一合法');
    expect(result.summarySeq).toBe(8);
  });
});
