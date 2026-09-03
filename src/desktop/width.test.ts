/**
 * CJK 双件单元测试（十一律第 9 条）：列宽（eastAsianWidthType 唯一真相源）与
 * 字素（Intl.Segmenter 用户感知边界）两件各自的裁决面 + 断行整字规则。
 */
import { describe, expect, it } from 'vitest';
import { codePointWidth, graphemesOf, stringWidth, truncateToWidth, wrapGraphemes } from './width.js';

describe('列宽（码点级——eastAsianWidthType 唯一真相源）', () => {
  it('CJK 统一表意与全角 = 2 列；半角片假名/ambiguous/拉丁 = 1 列', () => {
    expect(codePointWidth(0x4e2d)).toBe(2); // 中（wide）
    expect(codePointWidth(0xff21)).toBe(2); // Ａ（fullwidth）
    expect(codePointWidth(0x3000)).toBe(2); // 全角空格（fullwidth）
    expect(codePointWidth(0xff61)).toBe(1); // ｡ 半角句点（halfwidth）
    expect(codePointWidth(0x2018)).toBe(1); // ' （ambiguous → 1 语境取舍）
    expect(codePointWidth(0xfe0f)).toBe(1); // VS16 本体 neutral
    expect(codePointWidth(0x61)).toBe(1); // a
    expect(codePointWidth(0x20)).toBe(1); // 空格
  });

  it('emoji 本体 wide = 2；RI/零宽连接符本体 neutral = 1（字素级另裁）', () => {
    expect(codePointWidth(0x1f600)).toBe(2); // 😀
    expect(codePointWidth(0x1f1e8)).toBe(1); // RI（旗帜单码点——字素级才成对成 2）
    expect(codePointWidth(0x200d)).toBe(1); // ZWJ
  });
});

describe('字素（用户感知边界永不撕裂）', () => {
  it('中文逐字素；ZWJ 家族/旗帜/VS16 序列各自合为一', () => {
    expect(graphemesOf('你好')).toHaveLength(2);
    expect(graphemesOf('a👍')).toHaveLength(2);
    const family = graphemesOf('\u{1F468}‍\u{1F469}‍\u{1F467}'); // 一家三口
    expect(family).toHaveLength(1);
    expect(family[0]!.width).toBe(2); // 含 wide emoji 本体 → 双宽
    const flag = graphemesOf('\u{1F1E8}\u{1F1F3}'); // 中国旗
    expect(flag).toHaveLength(1);
    expect(flag[0]!.width).toBe(2); // RI 对 → 双宽（码点级覆盖不到的字形）
    const heart = graphemesOf('\u{2764}\u{FE0F}'); // ❤️（VS16 emoji 呈现）
    expect(heart).toHaveLength(1);
    expect(heart[0]!.width).toBe(2); // VS16 → 双宽
    expect(graphemesOf('\u{2764}')).toHaveLength(1); // 裸 ❤ 文本呈现
    expect(graphemesOf('\u{2764}')[0]!.width).toBe(1);
  });
});

describe('stringWidth / truncateToWidth', () => {
  it('中西混排总宽 = 字素宽度和', () => {
    expect(stringWidth('')).toBe(0);
    expect(stringWidth('abc')).toBe(3);
    expect(stringWidth('中文a')).toBe(5);
    expect(stringWidth('\u{1F1E8}\u{1F1F3}国')).toBe(4); // 旗(2) + 国(2)
  });

  it('宽度裁剪整字截断——不产生半字', () => {
    expect(truncateToWidth('中英文mix', 5)).toBe('中英'); // 2+2=4，再放不下 '文'(2)
    expect(truncateToWidth('abcdef', 3)).toBe('abc');
    expect(truncateToWidth('中文', 1)).toBe('');
  });
});

describe('wrapGraphemes 字素整字换行', () => {
  it('列宽折行 + 显式换行', () => {
    expect(wrapGraphemes('中文abc', 4)).toEqual(['中文', 'abc']);
    expect(wrapGraphemes('a\nb', 10)).toEqual(['a', 'b']);
    expect(wrapGraphemes('', 10)).toEqual(['']);
  });

  it('宽字符行末不悬挂：剩 1 列遇双宽字素整字下移', () => {
    // 宽 5：'中英'(4) 后剩 1 列放不下 '文' → 下移
    expect(wrapGraphemes('中英文', 5)).toEqual(['中英', '文']);
  });

  it('emoji ZWJ 家族跨行不撕裂', () => {
    const text = `ab\u{1F468}‍\u{1F469}‍\u{1F467}cd`;
    const lines = wrapGraphemes(text, 3); // 家族(2) 放不进 'ab'(2) 后剩 1 列
    expect(lines[0]).toBe('ab');
    expect(lines[1]!.startsWith('\u{1F468}')).toBe(true); // 家族整字素下行
    expect(lines).toHaveLength(3); // 'ab' / 家族+c(2+1=3) / 'd'
  });
});
