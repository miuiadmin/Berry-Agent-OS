/**
 * Oracle 测试（十一律第 10 条）：@xterm/headless 终端仿真器吃引擎产出的 ANSI
 * 字节流，缓冲真相 vs 预期网格互证——全量帧与差分帧两侧的「第二真相源」。
 */
import { describe, expect, it } from 'vitest';
import pkg from '@xterm/headless';
import { CellBuffer } from './cell.js';
import { createRowDiff, diffRows, writeDiff } from './diff.js';

const { Terminal } = pkg;

/** 写入并等 xterm 消化完成（write 异步——断言必须落在回调后） */
function writeTerm(term: import('@xterm/headless').Terminal, data: string): Promise<void> {
  return new Promise((res) => term.write(data, res));
}

/** 渲染一帧并取出 ANSI 内容段（front→back 差分；forceFull 全量） */
function frameContent(front: CellBuffer, back: CellBuffer, forceFull: boolean): string {
  const rd = createRowDiff(back.height);
  diffRows(front, back, rd);
  return writeDiff(back, rd, forceFull);
}

describe('oracle：全量帧', () => {
  it('文本行 + 空白行：xterm 缓冲 = 预期网格（EL 清行无空格填充）', async () => {
    const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    const back = new CellBuffer(20, 3);
    back.writeString(0, 0, 'hello world');
    const content = frameContent(new CellBuffer(20, 3), back, true);
    // 全量帧无字面填充串：内容段不含 4+ 连空格（EL 清行纪律的可观测面）
    expect(content).not.toMatch(/ {4,}/);
    await writeTerm(term, content);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('hello world');
    expect(term.buffer.active.getLine(1)!.translateToString(true)).toBe('');
    expect(term.buffer.active.getLine(2)!.translateToString(true)).toBe('');
  });

  it('CJK：xterm 宽字符双格 + 续格 width 0（与 cell 模型同构）', async () => {
    const term = new Terminal({ cols: 10, rows: 1, allowProposedApi: true });
    const back = new CellBuffer(10, 1);
    back.writeString(0, 0, '中a文');
    await writeTerm(term, frameContent(new CellBuffer(10, 1), back, true));
    const line = term.buffer.active.getLine(0)!;
    expect(line.translateToString(true)).toBe('中a文');
    expect(line.getCell(0)!.getChars()).toBe('中');
    expect(line.getCell(0)!.getWidth()).toBe(2);
    expect(line.getCell(1)!.getWidth()).toBe(0); // 续格（与 CONTINUATION 同构）
    expect(line.getCell(2)!.getChars()).toBe('a');
    expect(line.getCell(3)!.getChars()).toBe('文');
  });

  it('2026 同步输出包裹被容忍：内容照常落格', async () => {
    const term = new Terminal({ cols: 10, rows: 1, allowProposedApi: true });
    const back = new CellBuffer(10, 1);
    back.writeString(0, 0, 'ok');
    const content = frameContent(new CellBuffer(10, 1), back, true);
    await writeTerm(term, `\x1b[?2026h${content}\x1b[?2026l`); // 引擎组装形
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('ok');
  });
});

describe('oracle：差分帧', () => {
  it('同前缀缩短：CUP + 尾写 + EL——无字面空格游程', async () => {
    const term = new Terminal({ cols: 12, rows: 1, allowProposedApi: true });
    const front = new CellBuffer(12, 1);
    front.writeString(0, 0, 'hello'); // 屏上真相
    await writeTerm(term, frameContent(new CellBuffer(12, 1), front, true)); // 先落屏
    // 本帧：'help'（col3 变 p，尾缩短）
    const back = new CellBuffer(12, 1);
    back.writeString(0, 0, 'help');
    const delta = frameContent(front, back, false);
    // 差分纪律：只动变更格 + EL 洗尾——不含多空格字面
    expect(delta).not.toMatch(/ {2,}/);
    expect(delta).toContain('\x1b[K'); // 尾清行走 EL
    await writeTerm(term, delta);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('help');
  });

  it('中段变更：同行后段不变不重写（delta 只含变更段）', async () => {
    const term = new Terminal({ cols: 12, rows: 1, allowProposedApi: true });
    const front = new CellBuffer(12, 1);
    front.writeString(0, 0, 'abcXYZ');
    await writeTerm(term, frameContent(new CellBuffer(12, 1), front, true));
    const back = new CellBuffer(12, 1);
    back.writeString(0, 0, 'abcQYZ'); // 只 col3 变
    const delta = frameContent(front, back, false);
    expect(delta).toContain('Q');
    expect(delta).not.toContain('X');
    expect(delta).not.toContain('abc'); // 前缀未变不重写
    await writeTerm(term, delta);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('abcQYZ');
  });

  it('宽字符覆写洗净续格：全角替半角无残迹', async () => {
    const term = new Terminal({ cols: 10, rows: 1, allowProposedApi: true });
    const front = new CellBuffer(10, 1);
    front.writeString(0, 0, 'ab');
    await writeTerm(term, frameContent(new CellBuffer(10, 1), front, true));
    const back = new CellBuffer(10, 1);
    back.writeString(0, 0, '中'); // 宽字符覆写两格
    await writeTerm(term, frameContent(front, back, false));
    const line = term.buffer.active.getLine(0)!;
    expect(line.getCell(0)!.getChars()).toBe('中');
    expect(line.getCell(1)!.getWidth()).toBe(0); // b 的残迹被续格洗净
    expect(line.getCell(2)!.getChars()).toBe(''); // 续格 chars 空
  });

  it('未变行零写出：跨行差分只动变更行', async () => {
    const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
    const front = new CellBuffer(10, 3);
    front.writeString(0, 0, 'r0');
    front.writeString(0, 1, 'r1');
    front.writeString(0, 2, 'r2');
    await writeTerm(term, frameContent(new CellBuffer(10, 3), front, true));
    const back = new CellBuffer(10, 3);
    back.writeString(0, 0, 'r0');
    back.writeString(0, 1, 'R1'); // 只行 1 变
    back.writeString(0, 2, 'r2');
    const delta = frameContent(front, back, false);
    expect(delta).toContain('R'); // 只写变更格 'r'→'R'（'1' 未变不重写）
    expect(delta).not.toContain('r0');
    expect(delta).not.toContain('r2');
    await writeTerm(term, delta);
    expect(term.buffer.active.getLine(1)!.translateToString(true)).toBe('R1');
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('r0');
    expect(term.buffer.active.getLine(2)!.translateToString(true)).toBe('r2');
  });

  it('同首码点字素更替（👨‍👩→👨‍👨）：差分非空且屏上换新（遗漏大扫 20260903 desktop D3-1 修死）', async () => {
    const term = new Terminal({ cols: 10, rows: 1, allowProposedApi: true });
    const front = new CellBuffer(10, 1);
    front.writeString(0, 0, '👨‍👩'); // 屏上真相（多码点字素整字存稀疏面）
    await writeTerm(term, frameContent(new CellBuffer(10, 1), front, true));
    // 本帧：同格换同首码点的另一家族 emoji——chars/styles/widths 三数组全等
    // （同首码点 U+1F468 / 同宽 2），修前差分空串 → 零写出且「零变更零写出」
    // 早退跳过双缓冲换位 → front 基线永持旧字素，屏上永久陈旧
    const back = new CellBuffer(10, 1);
    back.writeString(0, 0, '👨‍👨');
    const delta = frameContent(front, back, false);
    expect(delta).not.toBe(''); // 修前空串——红（探针 probe-grapheme 形态）
    expect(delta).toContain('👨‍👨'); // 整字素写出（稀疏面取回全文）
    await writeTerm(term, delta);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toContain('👨‍👨');
  });
});
