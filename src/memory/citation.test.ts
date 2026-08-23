/**
 * L3 memory 单元测试——引用标记解析（记忆篇 §6 引用回写，第十二批拍板题一）。
 * 纯函数面：标记形态钉死 [m:8位hex]、去重计数、普通方括号文本不误伤。
 */

import { describe, expect, it } from 'vitest';
import { CITATION_INSTRUCTION, citationMarker, parseCitationShortIds, textOfAssistantContent } from './citation.js';
import { shortIdOf } from './id.js';

describe('citationMarker / shortIdOf（标记构造）', () => {
  it('完整 id → 首段 8 位十六进制短 id + [m:] 包裹', () => {
    expect(shortIdOf('0a1b2c3d-7000-7000-8000-abcdefabcdef')).toBe('0a1b2c3d');
    expect(citationMarker('0a1b2c3d-7000-7000-8000-abcdefabcdef')).toBe('[m:0a1b2c3d]');
  });

  it('引用指令句携带格式示例（注入面与标记同源）', () => {
    expect(CITATION_INSTRUCTION).toContain('[m:00000000]');
  });
});

describe('parseCitationShortIds（assistant 文本解析——尽力而为）', () => {
  it('单条与多条标记命中，保出现序', () => {
    expect(parseCitationShortIds('据记忆 [m:0a1b2c3d] 判断')).toEqual(['0a1b2c3d']);
    expect(parseCitationShortIds('见 [m:aaaaaaaa] 与 [m:bbbbbbbb] 两条')).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('同 id 重复出现计一次（一条消息对一条记忆 = 一次引用）', () => {
    expect(parseCitationShortIds('[m:0a1b2c3d] 再说一次 [m:0a1b2c3d]')).toEqual(['0a1b2c3d']);
  });

  it('普通方括号文本不误伤（Markdown 链接 / 非十六进制 / 长度不对 / 非 m 前缀）', () => {
    expect(parseCitationShortIds('参见 [链接](https://x) 与 [ref-7] 规范')).toEqual([]);
    expect(parseCitationShortIds('[m:0a1b2c3g]')).toEqual([]); // g 非十六进制
    expect(parseCitationShortIds('[m:0a1b2c3]')).toEqual([]); // 7 位
    expect(parseCitationShortIds('[m:0a1b2c3dd]')).toEqual([]); // 9 位——正则不匹配（非贪婪边界）
    expect(parseCitationShortIds('[x:0a1b2c3d]')).toEqual([]); // 非 m 前缀
    expect(parseCitationShortIds('大写 [M:0A1B2C3D] 不命中')).toEqual([]); // 大小写敏感（短 id 生成面恒小写）
  });

  it('空文本 → 空数组', () => {
    expect(parseCitationShortIds('')).toEqual([]);
  });
});

describe('textOfAssistantContent（事件载荷文本提取）', () => {
  it('text 块拼接；string 直返；其他形态空串', () => {
    expect(
      textOfAssistantContent([
        { type: 'text', text: '甲' },
        { type: 'thinking', text: '乙' },
        { type: 'text', text: '丙' },
      ]),
    ).toBe('甲\n丙');
    expect(textOfAssistantContent('直返')).toBe('直返');
    expect(textOfAssistantContent(42)).toBe('');
    expect(textOfAssistantContent(null)).toBe('');
  });
});
