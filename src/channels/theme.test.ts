/**
 * L4 channels — accent 着色原语测试（D4 theme 渲染轻件，契约篇 §5.4 theme 条款）。
 *
 * 验收面：① 白名单八字全可着色（名→RGB 映射与 contracts ACCENT_COLOR_NAMES
 * 同集）；② #rrggbb hex 单形解析与 truecolor SGR 转译；③ 拒收面（表外色名 /
 * 3 位 hex / 8 位 hex / 无井号 / 空串）→ 恒等零 ANSI；④ 缺省律（undefined =
 * 合法零色缺省，非待修缺陷）。
 */

import { describe, expect, it } from 'vitest';
import { ACCENT_COLOR_NAMES } from '../contracts/app.js';
import { accentColorizer } from './theme.js';

describe('accentColorizer：白名单色名', () => {
  it.each([...ACCENT_COLOR_NAMES])('色名 %s → truecolor SGR 包裹', (name) => {
    const colorize = accentColorizer(name);
    // cyan = #06b6d4 是精确断言锚（映射值漂移即红）；其余色名只断 SGR 形状
    if (name === 'cyan') {
      expect(colorize('x')).toBe('\x1b[38;2;6;182;212mx\x1b[0m');
    } else {
      expect(colorize('x')).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[0m$/);
    }
  });

  it('八字与 contracts 常量同集（单一事实源对账——漂移即红）', () => {
    // 每个常量名都产 SGR（表内命中）；集合面由 contracts schema literals 执法，
    // 这里锁「名字必有着色」防映射表漏键
    for (const name of ACCENT_COLOR_NAMES) {
      expect(accentColorizer(name)('x')).not.toBe('x');
    }
  });
});

describe('accentColorizer：#rrggbb hex 单形', () => {
  it('六位 hex → truecolor（大小写不敏感）', () => {
    expect(accentColorizer('#06b6d4')('x')).toBe('\x1b[38;2;6;182;212mx\x1b[0m');
    expect(accentColorizer('#EF4444')('x')).toBe('\x1b[38;2;239;68;68mx\x1b[0m');
  });

  it('非六位形拒收 → 恒等（schema 已执法，此处防御式缺省）', () => {
    // 3 位 / 8 位 / 无井号 / 非十六进制字符皆不收（单形免歧义）
    expect(accentColorizer('#abc')('x')).toBe('x');
    expect(accentColorizer('#06b6d4ff')('x')).toBe('x');
    expect(accentColorizer('06b6d4')('x')).toBe('x');
    expect(accentColorizer('#zzzzzz')('x')).toBe('x');
    expect(accentColorizer('')('x')).toBe('x');
  });
});

describe('accentColorizer：缺省律', () => {
  it('undefined → 恒等零 ANSI（零色是合法缺省态）', () => {
    expect(accentColorizer(undefined)('● 工作中')).toBe('● 工作中');
  });

  it('表外色名 → 恒等（通道侧防御：非法值按缺省处理不崩）', () => {
    expect(accentColorizer('notacolor')('x')).toBe('x');
    expect(accentColorizer('crimson')('x')).toBe('x'); // CSS 开放集合名不收
  });
});
