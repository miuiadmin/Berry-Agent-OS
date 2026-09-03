/**
 * cell 网格单元测试（十一律第 1/2/6 条）：打包 TypedArray 三件套的写入纪律——
 * 宽字符续格、多码点字素稀疏面、覆写摘痕、边界截断、样式打包、光标声明。
 */
import { describe, expect, it } from 'vitest';
import { CellBuffer, CONTINUATION, packStyle, unpackStyle } from './cell.js';
import type { Style } from './types.js';

describe('packStyle / unpackStyle 往返', () => {
  it('全缺省 = 0；属性位与调色板索引按位落位可逆', () => {
    expect(packStyle(undefined)).toBe(0);
    const style: Style = { fg: 3, bg: 12, bold: true, underline: true };
    const word = packStyle(style);
    expect(unpackStyle(word)).toEqual({
      fg: 3,
      bg: 12,
      bold: true,
      dim: false,
      italic: false,
      underline: true,
      reverse: false,
    });
    // 位域布局：属性低 5 位（bold bit0=1 + underline bit3=8）/ fg bit8+ / bg bit16+
    expect(word & 0b1001).toBe(0b1001);
    expect((word >> 8) & 0xff).toBe(3);
    expect((word >> 16) & 0xff).toBe(12);
    // 优先级括号回归锁：fg=0xff 不得被 << 8 的掩码吃掉低属性位
    expect(packStyle({ fg: 0xff }) & 0xff).toBe(0);
  });
});

describe('宽字符续格', () => {
  it('setCell 宽码点：首格存码点宽 2，右邻格 CONTINUATION 宽 0 同样式', () => {
    const buf = new CellBuffer(4, 1);
    buf.setCell(0, 0, 0x4e2d, { fg: 2 });
    expect(buf.cellAt(0, 0)).toEqual({ chars: '中', styleWord: packStyle({ fg: 2 }), width: 2 });
    expect(buf.cellAt(1, 0)).toEqual({ chars: '', styleWord: packStyle({ fg: 2 }), width: 0 });
    expect(buf.chars[1]).toBe(CONTINUATION);
  });

  it('宽字符落行末列：右半越界丢弃（第二列不悬挂）', () => {
    const buf = new CellBuffer(3, 1);
    buf.setCell(2, 0, 0x4e2d); // x=2 是末列，右邻出界
    expect(buf.cellAt(2, 0)!.width).toBe(2); // 首格照写
    // 出界格静默吸收：x=3 无格
    expect(buf.cellAt(3, 0)).toBeNull();
  });
});

describe('writeString 字素落位', () => {
  it('中西混排逐字素推进；宽字符占两列', () => {
    const buf = new CellBuffer(8, 1);
    buf.writeString(0, 0, 'a中b');
    expect(buf.cellAt(0, 0)!.chars).toBe('a');
    expect(buf.cellAt(1, 0)!.chars).toBe('中');
    expect(buf.cellAt(1, 0)!.width).toBe(2);
    expect(buf.cellAt(2, 0)!.width).toBe(0); // 续格
    expect(buf.cellAt(3, 0)!.chars).toBe('b');
  });

  it('右边界整字截断：剩 1 列遇宽字符整字不写', () => {
    const buf = new CellBuffer(5, 1);
    buf.writeString(0, 0, '中英文'); // 2+2 已满，'文' 放不下
    expect(buf.cellAt(0, 0)!.chars).toBe('中');
    expect(buf.cellAt(2, 0)!.chars).toBe('英');
    expect(buf.cellAt(4, 0)!.chars).toBe(' '); // 末列保持空白（整字截断）
  });

  it('多码点字素存稀疏面：cellAt 取回整字素、multiAt 命中', () => {
    const buf = new CellBuffer(6, 1);
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 一家三口
    buf.writeString(0, 0, `x${family}y`);
    expect(buf.cellAt(0, 0)!.chars).toBe('x');
    expect(buf.cellAt(1, 0)!.chars).toBe(family); // 整字素（非首码点）
    expect(buf.cellAt(1, 0)!.width).toBe(2);
    expect(buf.cellAt(2, 0)!.width).toBe(0);
    expect(buf.cellAt(3, 0)!.chars).toBe('y');
    expect(buf.multiAt(buf.width * 0 + 1)).toBe(family);
  });

  it('覆写摘痕：多码点字素被覆写后稀疏面引用清除', () => {
    const buf = new CellBuffer(4, 1);
    buf.writeString(0, 0, '\u{1F1E8}\u{1F1F3}'); // 中国旗（稀疏面）
    const flagIdx = 0;
    expect(buf.multiAt(flagIdx)).toBeDefined();
    buf.writeString(0, 0, 'ab'); // 覆写
    expect(buf.multiAt(flagIdx)).toBeUndefined();
    expect(buf.cellAt(0, 0)!.chars).toBe('a');
    expect(buf.cellAt(1, 0)!.chars).toBe('b');
    expect(buf.cellAt(1, 0)!.width).toBe(1); // 旧续格痕迹洗净
  });

  it('续格样式随首格一致（整字观感）', () => {
    const buf = new CellBuffer(4, 1);
    buf.writeString(0, 0, '中', { fg: 5, bold: true });
    const word = packStyle({ fg: 5, bold: true });
    expect(buf.cellAt(1, 0)!.styleWord).toBe(word);
  });
});

describe('fill / clear / equals', () => {
  it('fill 区域覆写（宽字符残留逐格洗净）', () => {
    const buf = new CellBuffer(4, 2);
    buf.writeString(0, 0, '中中');
    buf.fill({ x: 0, y: 0, width: 4, height: 1 }, { bg: 7 });
    expect(buf.cellAt(1, 0)!.width).toBe(1); // 续格被覆写
    expect(buf.cellAt(0, 0)).toEqual({ chars: ' ', styleWord: packStyle({ bg: 7 }), width: 1 });
    expect(buf.cellAt(0, 1)!.styleWord).toBe(0); // 区域外不动
  });

  it('clear 回初始空白画布；equals 同构判定', () => {
    const a = new CellBuffer(4, 2);
    const b = new CellBuffer(4, 2);
    expect(a.equals(b)).toBe(true);
    a.writeString(0, 0, 'hi');
    expect(a.equals(b)).toBe(false);
    a.clear();
    expect(a.equals(b)).toBe(true);
    // 尺寸不同构直接 false
    expect(a.equals(new CellBuffer(2, 4))).toBe(false);
  });

  it('初始态 = 空格 + 零样式 + 宽 1（差分基线与 EL 语义同构）', () => {
    const buf = new CellBuffer(2, 1);
    expect(buf.cellAt(0, 0)).toEqual({ chars: ' ', styleWord: 0, width: 1 });
    expect(buf.cellAt(1, 0)).toEqual({ chars: ' ', styleWord: 0, width: 1 });
  });
});

describe('光标声明', () => {
  it('setCursor/clearCursor/cursor——帧级唯一声明位', () => {
    const buf = new CellBuffer(4, 1);
    expect(buf.cursor).toBeNull();
    buf.setCursor(2, 0);
    expect(buf.cursor).toEqual({ x: 2, y: 0 });
    buf.clearCursor();
    expect(buf.cursor).toBeNull();
  });
});
