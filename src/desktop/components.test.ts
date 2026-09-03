/**
 * 组件层单元测试（十一律第 4/5 条）：h() 构造、Text/Paragraph、
 * Column/Flex/Row/Inset 协商与分配（无约束求解器）、SingleLineInput 全操作面
 * （光标/插入/删除/移动/CJK 双宽光标对齐/预编辑/水平滚动）。
 */
import { describe, expect, it } from 'vitest';
import { Column, Flex, h, Inset, isFlexRenderable, Paragraph, Row, SingleLineInput, Text } from './components.js';
import { CellBuffer } from './cell.js';
import type { Area, Renderable } from './types.js';

/** 区域记录探针（布局分配断言面——渲染时记下所得区域） */
class Probe implements Renderable {
  lastArea: Area | null = null;
  desiredHeight(): number {
    return 1;
  }
  render(area: Area): void {
    this.lastArea = area;
  }
}

/** 渲染到独立缓冲的捷径（单件渲染断言） */
function renderInto(r: Renderable, width: number, height: number): CellBuffer {
  const buf = new CellBuffer(width, height);
  r.render({ x: 0, y: 0, width, height }, buf);
  return buf;
}

/** 一行文本快照（续格并入宽字符、trim 尾空格——断言可读面） */
function rowText(buf: CellBuffer, y: number): string {
  let s = '';
  for (let x = 0; x < buf.width; x++) {
    const c = buf.cellAt(x, y)!;
    s += c.width === 0 ? '' : c.chars || ' ';
  }
  return s.trimEnd();
}

describe('h() 函数式构造 + Flex 判据', () => {
  it('h 返回组件实例；isFlexRenderable 只认 isFlex=true', () => {
    const t = h(Text, { content: 'x' });
    expect(t).toBeInstanceOf(Text);
    expect(isFlexRenderable(t)).toBe(false);
    const f = h(Flex, { child: t });
    expect(isFlexRenderable(f)).toBe(true);
  });
});

describe('Text / Paragraph 文本件', () => {
  it('Text 单行截断不越界；desiredHeight 恒 1', () => {
    const t = h(Text, { content: '中英文', style: { fg: 3 } });
    expect(t.desiredHeight()).toBe(1);
    const buf = renderInto(t, 5, 1);
    expect(rowText(buf, 0)).toBe('中英'); // '文' 放不下整字截断
  });

  it('Paragraph 折行：desiredHeight 随宽收敛；render 按行落位', () => {
    const p = h(Paragraph, { content: '中文abc中文' });
    expect(p.desiredHeight(4)).toBe(3); // 中文 / abc / 中文（'abc'+宽'中'=5 > 4 整字下移）
    expect(p.desiredHeight(11)).toBe(1); // 总宽 11 恰一行
    const buf = renderInto(p, 4, 3);
    expect(rowText(buf, 0)).toBe('中文');
    expect(rowText(buf, 1)).toBe('abc');
    expect(rowText(buf, 2)).toBe('中文');
    // 高度不足截尾：只画得下 2 行
    const buf2 = renderInto(p, 4, 2);
    expect(rowText(buf2, 1)).toBe('abc');
  });

  it('Paragraph 显式换行', () => {
    const p = h(Paragraph, { content: 'a\nb\nc' });
    expect(p.desiredHeight(10)).toBe(3);
  });
});

describe('Column：固定子定高 + Flex 吸余量', () => {
  it('固定子顺排；Flex 子吸尽余量；余数给末 Flex 子', () => {
    const probe = new Probe();
    const col = h(Column, {
      children: [h(Text, { content: 'top' }), h(Flex, { child: probe }), h(Text, { content: 'bot' })],
    });
    const buf = renderInto(col, 10, 6);
    expect(probe.lastArea).toEqual({ x: 0, y: 1, width: 10, height: 4 }); // 1 + 4 + 1
    expect(rowText(buf, 0)).toBe('top');
    expect(rowText(buf, 5)).toBe('bot');
  });

  it('双 Flex 均分：整除余数给末子', () => {
    const p1 = new Probe();
    const p2 = new Probe();
    renderInto(
      h(Column, { children: [h(Text, { content: 'h' }), h(Flex, { child: p1 }), h(Flex, { child: p2 })] }),
      10,
      6,
    );
    expect(p1.lastArea).toEqual({ x: 0, y: 1, width: 10, height: 2 });
    expect(p2.lastArea).toEqual({ x: 0, y: 3, width: 10, height: 3 }); // 余数吸收
  });

  it('底部溢出截断：固定子超出总高即停', () => {
    const col = h(Column, {
      children: [h(Text, { content: 'a' }), h(Text, { content: 'b' }), h(Text, { content: 'c' })],
    });
    // 缓冲 3 行、区域只给 2 行——'c' 无行可落
    const buf = new CellBuffer(10, 3);
    col.render({ x: 0, y: 0, width: 10, height: 2 }, buf);
    expect(rowText(buf, 0)).toBe('a');
    expect(rowText(buf, 1)).toBe('b');
    expect(rowText(buf, 2)).toBe('');
  });

  it('desiredHeight 协商：固定子按期望、Flex 子按最小占位 1', () => {
    const col = h(Column, {
      children: [
        h(Paragraph, { content: '中文abc中文' }), // 宽 4 → 3 行
        h(Flex, { child: new Probe() }),
        h(Text, { content: 'x' }),
      ],
    });
    expect(col.desiredHeight(4)).toBe(3 + 1 + 1);
  });
});

describe('Row：权重分宽', () => {
  it('等权三列；权重 [1,2] 分 3/6；desiredHeight = 各子最大', () => {
    const a = h(Text, { content: 'aa' });
    const b = h(Text, { content: 'bbbbbb' });
    const row = h(Row, { children: [a, b], weights: [1, 2] });
    expect(row.desiredHeight(9)).toBe(1);
    const buf = renderInto(row, 9, 1);
    // a 区 3 列（'aa' 占 2 留 1 空格）、b 区 6 列从 x=3 起
    expect(rowText(buf, 0)).toBe('aa bbbbbb');
    expect(buf.cellAt(2, 0)!.chars).toBe(' ');
  });

  it('缺省等权两列', () => {
    const buf = renderInto(h(Row, { children: [h(Text, { content: 'ab' }), h(Text, { content: 'cd' })] }), 8, 1);
    expect(buf.cellAt(3, 0)!.chars).toBe(' '); // 第一列 4 宽，'ab' 后留白
    expect(buf.cellAt(4, 0)!.chars).toBe('c');
  });
});

describe('Inset：内缩与夹取', () => {
  it('四向收缩后子件整交渲染', () => {
    const buf = renderInto(h(Inset, { child: h(Text, { content: 'hi' }), top: 1, left: 2 }), 8, 3);
    expect(buf.cellAt(2, 1)!.chars).toBe('h');
    expect(rowText(buf, 0)).toBe(''); // 顶行留白
  });

  it('desiredHeight 含边距', () => {
    const inset = h(Inset, { child: h(Paragraph, { content: '中文abc中文' }), top: 1, bottom: 2 });
    expect(inset.desiredHeight(4)).toBe(3 + 3);
  });
});

describe('SingleLineInput：操作面', () => {
  it('insertText/setText/clear + 字素级移动与删除（CJK）', () => {
    const input = h(SingleLineInput, {});
    input.insertText('中');
    input.insertText('a');
    expect(input.text).toBe('中a');
    expect(input.cursor).toBe(2);
    input.moveLeft(); // 光标到 'a' 前（'中' 后）
    expect(input.cursor).toBe(1);
    input.insertText('文'); // '中文a'
    expect(input.text).toBe('中文a');
    input.backspace(); // 删 '文'
    expect(input.text).toBe('中a');
    input.moveHome();
    input.deleteForward(); // 删 '中'
    expect(input.text).toBe('a');
    input.moveEnd();
    input.backspace();
    input.backspace(); // 行首再退格无操作
    expect(input.text).toBe('');
    expect(input.cursor).toBe(0);
  });

  it('emoji 字素整删（ZWJ 家族一步退格）', () => {
    const input = h(SingleLineInput, {});
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    input.setText(`a${family}b`);
    expect(input.cursor).toBe(3); // a + 家族 + b = 3 字素
    input.moveLeft(); // 光标到家族后（'b' 前）
    input.backspace(); // 一步删整家族
    expect(input.text).toBe('ab');
  });

  it('setText 光标归尾；clear 归零', () => {
    const input = h(SingleLineInput, {});
    input.setText('你好');
    expect(input.cursor).toBe(2);
    input.clear();
    expect(input.cursor).toBe(0);
  });
});

describe('SingleLineInput：渲染面', () => {
  it('CJK 双宽光标对齐：光标列 = 前缀宽 + 光标前字素列宽和', () => {
    const input = h(SingleLineInput, { prompt: '> ' });
    input.setText('中a');
    // 光标尾：2(前缀) + 2(中) + 1(a) = 5
    let buf = renderInto(input, 12, 1);
    expect(buf.cursor).toEqual({ x: 5, y: 0 });
    // 光标在 '中' 前：2
    input.moveHome();
    buf = renderInto(input, 12, 1);
    expect(buf.cursor).toEqual({ x: 2, y: 0 });
    // 光标在 '中' 后（宽字符光标落其首列语义的对称位）：4
    input.moveRight();
    buf = renderInto(input, 12, 1);
    expect(buf.cursor).toEqual({ x: 4, y: 0 });
    expect(rowText(buf, 0)).toBe('> 中a');
  });

  it('预编辑渲染：下划线段 + 光标在预编辑尾（不并入正文）', () => {
    const input = h(SingleLineInput, { prompt: '' });
    input.setText('ni');
    input.setPreedit('hao');
    const buf = renderInto(input, 12, 1);
    expect(rowText(buf, 0)).toBe('nihao');
    expect(buf.cursor).toEqual({ x: 5, y: 0 }); // 正文尾 + 预编辑尾
    // 预编辑段带下划线样式
    expect(buf.cellAt(2, 0)!.styleWord).not.toBe(0);
    input.setPreedit(null);
    const buf2 = renderInto(input, 12, 1);
    expect(rowText(buf2, 0)).toBe('ni');
  });

  it('水平滚动：光标恒可视（右端锚定）', () => {
    const input = h(SingleLineInput, { prompt: '> ' });
    input.setText('abcdefgh');
    const buf = renderInto(input, 6, 1);
    // 光标列 = 2+8=10 ≥ 6 → startCol=5：可见 'd..h' + 光标 x=5
    expect(buf.cellAt(0, 0)!.chars).toBe('d');
    expect(buf.cellAt(4, 0)!.chars).toBe('h');
    expect(buf.cursor).toEqual({ x: 5, y: 0 });
  });

  it('失焦不落光标', () => {
    const input = h(SingleLineInput, { focused: false });
    input.setText('x');
    const buf = renderInto(input, 6, 1);
    expect(buf.cursor).toBeNull();
    expect(rowText(buf, 0)).toBe('x');
    input.focused = true;
    expect(renderInto(input, 6, 1).cursor).not.toBeNull();
  });
});
