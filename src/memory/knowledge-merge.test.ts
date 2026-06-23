import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenizeSummary,
  overlapScore,
  hasConflict,
  pickMergeCandidate,
  pickConflictCandidate,
  resolveConflictVerdict,
  pickBetterSummary,
  type MergeCandidateRow,
} from './knowledge-merge.js';
import { initDb, closeDb, getDb } from './db.js';

/**
 * knowledge-merge 纯函数单元测试 + addKnowledge 集成测试。
 *
 * 覆盖 设计文档/参考-mercury-v1.2.0-吸纳建议.md §A：
 * 插入时确定性模糊合并 + 极性冲突裁决。同时验证 CJK 字面量（POLARITY_PAIRS / CJK_NEGATIONS）
 * 未在写入时损坏——若中文极性词被编码破坏，hasConflict 相关用例会立刻失败。
 */

describe('tokenizeSummary（CJK 适配分词）', () => {
  it('中文逐字成 token', () => {
    const t = new Set(tokenizeSummary('用户偏好'));
    expect(t.has('用')).toBe(true);
    expect(t.has('户')).toBe(true);
    expect(t.has('偏')).toBe(true);
    expect(t.has('好')).toBe(true);
  });

  it('拉丁/数字连续串成一个 token（长度≥2）', () => {
    const t = new Set(tokenizeSummary('用 VSCode 写 TS'));
    expect(t.has('vscode')).toBe(true);
    expect(t.has('ts')).toBe(true);
    expect(t.has('用')).toBe(true);
    expect(t.has('写')).toBe(true);
  });

  it('单字符拉丁被忽略（避免噪声）', () => {
    const t = tokenizeSummary('a b c');
    expect(t.length).toBe(0);
  });

  it('空串返回空数组', () => {
    expect(tokenizeSummary('').length).toBe(0);
  });
});

describe('overlapScore（Jaccard）', () => {
  it('相同集合 = 1', () => {
    const a = tokenizeSummary('用户偏好简洁');
    expect(overlapScore(a, tokenizeSummary('用户偏好简洁'))).toBe(1);
  });

  it('完全不重叠 = 0', () => {
    expect(overlapScore(tokenizeSummary('苹果'), tokenizeSummary('香蕉'))).toBe(0);
  });

  it('子集关系 0 < x < 1', () => {
    const a = tokenizeSummary('用户偏好'); // {用,户,偏,好}
    const b = tokenizeSummary('用户偏好简洁'); // {用,户,偏,好,简,洁}
    const s = overlapScore(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(s).toBeCloseTo(4 / 6, 5); // 交集4 / 并集6
  });
});

describe('hasConflict（极性冲突）', () => {
  it('中文 喜欢 vs 不喜欢（同主题）→ 冲突', () => {
    expect(hasConflict('用户喜欢深色主题', '用户不喜欢深色主题')).toBe(true);
  });

  it('中文 启用 vs 禁用（同主题）→ 冲突', () => {
    expect(hasConflict('用户启用了通知', '用户禁用了通知')).toBe(true);
  });

  it('英文 prefers vs does not prefer（同主题）→ 冲突', () => {
    expect(hasConflict('User prefers dark mode', 'User does not prefer dark mode')).toBe(true);
  });

  it('双方都正面、不同主题 → 非冲突', () => {
    expect(hasConflict('用户喜欢猫', '用户喜欢狗')).toBe(false);
  });

  it('完全相同 → 非冲突（走合并路径）', () => {
    expect(hasConflict('用户偏好简洁', '用户偏好简洁')).toBe(false);
  });

  it('无关主题 → 非冲突', () => {
    expect(hasConflict('用户在写一个数据库', '今天天气很好')).toBe(false);
  });
});

describe('pickMergeCandidate / pickConflictCandidate', () => {
  const rows = (specs: Array<Partial<MergeCandidateRow> & { summary: string }>): MergeCandidateRow[] =>
    specs.map((s, i) => ({
      id: s.id ?? `r${i}`,
      summary: s.summary,
      detail: s.detail ?? null,
      confidence: s.confidence ?? 0.7,
      importance: s.importance ?? 0.5,
      durability: s.durability ?? 0.5,
      evidence_count: s.evidence_count ?? 1,
    }));

  it('高重叠非冲突 → 命中合并目标', () => {
    const r = rows([{ summary: '用户偏好简洁的中文回复' }]);
    expect(pickMergeCandidate(r, '用户偏好简洁的中文回复风格')?.id).toBe('r0');
  });

  it('极性冲突 → 不作为合并目标（留给冲突路径）', () => {
    const r = rows([{ summary: '用户喜欢深色主题' }]);
    expect(pickMergeCandidate(r, '用户不喜欢深色主题')).toBeUndefined();
  });

  it('低重叠 → 不合并', () => {
    const r = rows([{ summary: '用户在养一只猫' }]);
    expect(pickMergeCandidate(r, '用户在写数据库迁移')).toBeUndefined();
  });

  it('极性冲突 → 命中冲突目标', () => {
    const r = rows([{ summary: '用户喜欢深色主题', confidence: 0.9 }]);
    expect(pickConflictCandidate(r, '用户不喜欢深色主题')?.id).toBe('r0');
  });
});

describe('resolveConflictVerdict / pickBetterSummary', () => {
  it('incoming confidence 更高 → incoming 胜', () => {
    expect(resolveConflictVerdict(0.6, 0.9)).toBe('incoming');
  });

  it('existing confidence 更高 → existing 胜', () => {
    expect(resolveConflictVerdict(0.9, 0.6)).toBe('existing');
  });

  it('confidence 相等 → incoming 胜（更新鲜）', () => {
    expect(resolveConflictVerdict(0.8, 0.8)).toBe('incoming');
  });

  it('incoming 更长且 ≤220 → 取 incoming', () => {
    expect(pickBetterSummary('短摘要', '这是一个更长的摘要内容')).toBe('这是一个更长的摘要内容');
  });

  it('incoming 超长 → 保留 existing', () => {
    const long = 'x'.repeat(230);
    expect(pickBetterSummary('短摘要', long)).toBe('短摘要');
  });
});

describe('addKnowledge 集成：确定性合并/冲突（真实 knowledge 表）', () => {
  let dir: string;

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fresh() {
    dir = mkdtempSync(join(tmpdir(), 'berry-kmerge-'));
    initDb(join(dir, 'test.db'));
    return getDb();
  }

  /** 统计某 owner+type 的 active（未 dismissed）条数 */
  const activeCount = (type: string, owner = 'user:owner') =>
    getDb()
      .prepare(`SELECT COUNT(*) as n FROM knowledge WHERE owner_key=? AND type=? AND dismissed=0`)
      .get(owner, type) as { n: number };

  it('模糊同义 → 合并强化（evidence_count++，不新增行）', async () => {
    fresh();
    const { addKnowledge } = await import('./knowledge.js');
    addKnowledge({ type: 'preference', summary: '用户偏好简洁的中文回复', confidence: 0.8 });
    addKnowledge({ type: 'preference', summary: '用户偏好简洁的中文回复风格', confidence: 0.7 });

    expect(activeCount('preference').n).toBe(1); // 合并，仍是 1 条
    const row = getDb().prepare(`SELECT evidence_count, confidence FROM knowledge WHERE dismissed=0`).get() as { evidence_count: number; confidence: number };
    expect(row.evidence_count).toBe(2); // 强化
    expect(row.confidence).toBe(0.8); // max(0.8,0.7)，保强证据
  });

  it('极性冲突 incoming 更可信 → 旧条 dismissed，新条插入', async () => {
    fresh();
    const { addKnowledge } = await import('./knowledge.js');
    addKnowledge({ type: 'preference', summary: '用户喜欢深色主题', confidence: 0.6 });
    addKnowledge({ type: 'preference', summary: '用户不喜欢深色主题', confidence: 0.9 });

    expect(activeCount('preference').n).toBe(1); // 只有新条 active
    const active = getDb().prepare(`SELECT summary FROM knowledge WHERE dismissed=0`).get() as { summary: string };
    expect(active.summary).toBe('用户不喜欢深色主题');
    const dismissed = getDb().prepare(`SELECT COUNT(*) as n FROM knowledge WHERE dismissed=1 AND superseded_by='auto_resolved'`).get() as { n: number };
    expect(dismissed.n).toBe(1); // 旧条被自动裁决 dismiss
  });

  it('极性冲突 existing 更可信 → 不插入新条，仅刷新既有', async () => {
    fresh();
    const { addKnowledge } = await import('./knowledge.js');
    addKnowledge({ type: 'preference', summary: '用户喜欢深色主题', confidence: 0.9 });
    addKnowledge({ type: 'preference', summary: '用户不喜欢深色主题', confidence: 0.6 });

    expect(activeCount('preference').n).toBe(1);
    const active = getDb().prepare(`SELECT summary FROM knowledge WHERE dismissed=0`).get() as { summary: string };
    expect(active.summary).toBe('用户喜欢深色主题'); // 既有保留
    expect(activeCount('preference').n).toBe(1);
    const totalRows = getDb().prepare(`SELECT COUNT(*) as n FROM knowledge`).get() as { n: number };
    expect(totalRows.n).toBe(1); // 未插入新行
  });

  it('完全相同 summary → 走精确合并（evidence_count++）', async () => {
    fresh();
    const { addKnowledge } = await import('./knowledge.js');
    addKnowledge({ type: 'preference', summary: '用户偏好简洁', confidence: 0.7 });
    addKnowledge({ type: 'preference', summary: '用户偏好简洁', confidence: 0.7 });

    expect(activeCount('preference').n).toBe(1);
    const row = getDb().prepare(`SELECT evidence_count FROM knowledge WHERE dismissed=0`).get() as { evidence_count: number };
    expect(row.evidence_count).toBe(2);
  });

  it('无关不同事实 → 各自独立插入', async () => {
    fresh();
    const { addKnowledge } = await import('./knowledge.js');
    addKnowledge({ type: 'preference', summary: '用户在养一只猫', confidence: 0.8 });
    addKnowledge({ type: 'preference', summary: '用户在写数据库迁移脚本', confidence: 0.8 });

    expect(activeCount('preference').n).toBe(2); // 不合并不冲突
  });
});
