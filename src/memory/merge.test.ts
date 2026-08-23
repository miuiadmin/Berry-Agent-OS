/**
 * L3 memory 单元测试（合并管线纯函数半边）——tokenize / jaccard / 极性检测（含中文对）/
 * classifyMerge 分支顺序。全确定性纯函数，无 IO 无 mock。
 */

import { describe, expect, it } from 'vitest';
import {
  FUZZY_THRESHOLD,
  POLARITY_OVERLAP_THRESHOLD,
  classifyMerge,
  detectPolarity,
  isPolarityConflict,
  jaccard,
  overlapScore,
  tokenize,
} from './merge.js';

describe('tokenize（中英文同形切词）', () => {
  it('英文按词切、数字成段、大小写归一', () => {
    expect([...tokenize('Use PNPM install Node22 now')].sort()).toEqual(['install', 'node22', 'now', 'pnpm', 'use']);
  });
  it('中文无空格逐段成 token（Unicode 字母连续段）', () => {
    expect([...tokenize('喜欢用 pnpm')]).toEqual(['喜欢用', 'pnpm']);
  });
  it('标点与空白全剥', () => {
    expect([...tokenize('a.b, c! (d)')]).toEqual(['a', 'b', 'c', 'd']);
  });
  it('空串 → 空集', () => {
    expect(tokenize('  !! ?? ').size).toBe(0);
  });
});

describe('jaccard（token 集合相似度）', () => {
  it('空对空 = 1（完全一致）', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
  it('恒等 = 1；不相交 = 0', () => {
    const a = new Set(['x', 'y']);
    expect(jaccard(a, new Set(['x', 'y']))).toBe(1);
    expect(jaccard(a, new Set(['p', 'q']))).toBe(0);
  });
  it('交并比数值正确（2 交 4 并 = 0.5）', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(0.5);
  });
});

describe('detectPolarity（极性标记，含中文扩展对）', () => {
  it('英文四对 Mercury 原案', () => {
    expect(detectPolarity('user prefers pnpm')).toBe('positive');
    expect(detectPolarity('user does not prefer npm')).toBe('negative');
    expect(detectPolarity('likes dark mode')).toBe('positive');
    expect(detectPolarity('dislikes dark mode')).toBe('negative');
    expect(detectPolarity('telemetry enabled')).toBe('positive');
    expect(detectPolarity('telemetry disabled')).toBe('negative');
  });
  it('中文三对：负向优先（「不喜欢」不误判正向）', () => {
    expect(detectPolarity('用户不喜欢框架自动提交')).toBe('negative');
    expect(detectPolarity('用户喜欢中文注释')).toBe('positive');
    expect(detectPolarity('总是先跑测试')).toBe('positive');
    expect(detectPolarity('从不直接 push 主分支')).toBe('negative');
  });
  it('无标记词 → undefined', () => {
    expect(detectPolarity('项目使用 TypeScript')).toBeUndefined();
  });
});

describe('isPolarityConflict（同主题 + 反极性）', () => {
  it('同主题反极性 → true（英文）', () => {
    expect(isPolarityConflict('user likes dark mode', 'user dislikes dark mode')).toBe(true);
  });
  it('同主题反极性 → true（中文）', () => {
    expect(isPolarityConflict('用户喜欢自动提交', '用户不喜欢自动提交')).toBe(true);
  });
  it('反极性但不同主题 → false', () => {
    expect(isPolarityConflict('user likes dark mode', 'user dislikes pnpm')).toBe(false);
  });
  it('同极性 → false', () => {
    expect(isPolarityConflict('likes dark mode', 'prefers dark mode')).toBe(false);
  });
});

describe('classifyMerge（三分支顺序 = 优先级）', () => {
  it('summary 全等 → exact', () => {
    expect(
      classifyMerge({ summary: '用户偏好 pnpm', confidence: 0.6 }, { summary: '用户偏好 pnpm', confidence: 0.9 }),
    ).toEqual({ type: 'exact' });
  });
  it('Jaccard ≥ 0.74 → fuzzy（Mercury 阈值实证位）', () => {
    // token 集 {a,b,c,d} vs {a,b,c,e}：3/5 = 0.6 不达；{a,b,c,d} vs {a,b,c,d,f}：4/6≈0.67 不达；
    // {a,b,c,d,e} vs {a,b,c,d,e,f}：5/6≈0.83 达标
    expect(overlapScore('a b c d e', 'a b c d e f')).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(
      classifyMerge({ summary: 'a b c d e', confidence: 0.5 }, { summary: 'a b c d e f', confidence: 0.5 }).type,
    ).toBe('fuzzy');
    expect(overlapScore('a b c d', 'a b c e')).toBeLessThan(FUZZY_THRESHOLD);
  });
  it('极性对 → polarity（低于模糊阈值的同主题反极性）', () => {
    expect(
      classifyMerge(
        { summary: 'user likes dark mode', confidence: 0.5 },
        { summary: 'user dislikes dark mode', confidence: 0.5 },
      ).type,
    ).toBe('polarity');
  });
  it('无任何匹配 → new', () => {
    expect(
      classifyMerge({ summary: '项目用 TypeScript', confidence: 0.5 }, { summary: '部署在云端', confidence: 0.5 }).type,
    ).toBe('new');
  });
  it('阈值常量来自实证（防手滑改坏）', () => {
    expect(FUZZY_THRESHOLD).toBe(0.74);
    expect(POLARITY_OVERLAP_THRESHOLD).toBe(0.5);
  });
});
