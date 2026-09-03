/**
 * 前帧差分 + ANSI 增量写出（十一律第 2/3 条）。
 * - 差分：逐行找首/尾变更格（ratatui 同形）——一行内只重写 [first, last] 闭区
 *   间；未变行零写出。比较基于三 TypedArray 逐格（char/style/width 任一异即变）。
 * - 清行：行尾变空白用 `\x1b[K`（EL）——**禁止空格填充**（CC Ink 空格填充闪烁
 *   史的直接反课）；EL 前先发 SGR 0（BCE 语义：EL 以当前背景色擦除——不复位
 *   会把前段 bg 涂进行尾）。
 * - 光标跳批：每变更行一个 CUP 覆盖整段连写（含样式变迁——段内不再动光标）；
 *   光标已天然落位（同行同列）时免跳。
 * - DECSET 2026 同步输出包裹由引擎统一组装（内容 + 光标段同帧原子呈现）——
 *   本函数只产内容段。
 * - 全量模式（forceFull：首帧/换防重进/resize——front 基线失真）同走 EL 清行
 *   语义：全空白行 = CUP + EL，零空格写出；不依赖空格填充。
 */
import type { CellBuffer } from './cell.js';

/** 每行差分结论（引擎持一份随缓冲尺寸滚动复用——帧路径不分配） */
export interface RowDiff {
  /** 首变更列；-1 = 本行无变更 */
  first: Int32Array;
  /** 尾变更列（含）；-1 = 本行无变更 */
  last: Int32Array;
  /** 行尾 [last+1, 行末) 是否全空白（EL 资格判定） */
  tailBlank: Uint8Array;
}

/** 分配一套行差分容器 */
export function createRowDiff(height: number): RowDiff {
  return {
    first: new Int32Array(height).fill(-1),
    last: new Int32Array(height).fill(-1),
    tailBlank: new Uint8Array(height),
  };
}

/**
 * 逐格差分 front（屏上真相）vs back（本帧渲染结果）→ 每行 [first, last] 变更区间。
 * 比较 chars/styles/widths 三数组逐格；多码点字素（稀疏面）三数组同格全等时追加
 * 比对稀疏 Map 全文（遗漏大扫 20260903 desktop D3-1：同首码点不同字素——家族
 * emoji 更替 👨‍👩→👨‍👨 同首码点同宽 2——三数组全等即判未变，零写出且「零变更零
 * 写出」早退跳过双缓冲换位 → 屏上永久陈旧；旧注「稀疏 Map 内容由写入路径保证
 * 一致」被探针 probe-grapheme 实测证伪，差分面必须自证）。
 */
export function diffRows(front: CellBuffer, back: CellBuffer, out: RowDiff): void {
  const w = front.width;
  // 稀疏面比对开关：两侧图全空 → 零 Map 查询（热路径零增量）；任一侧有字素才开
  const checkMulti = front.hasGraphemes() || back.hasGraphemes();
  for (let y = 0; y < front.height; y++) {
    const base = y * w;
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      const i = base + x;
      if (
        front.chars[i] !== back.chars[i] ||
        front.styles[i] !== back.styles[i] ||
        front.widths[i] !== back.widths[i] ||
        (checkMulti && !sameMultiGrapheme(front, back, i))
      ) {
        if (first < 0) first = x;
        last = x;
      }
    }
    out.first[y] = first;
    out.last[y] = last;
    // EL 资格：无变更行不需要；有变更行检查 back 的 (last, 末] 是否全空白格
    // （空白 = 空格 + 缺省样式 + 宽度 1——与 CellBuffer 初始态同构）
    if (last < 0) {
      out.tailBlank[y] = 0;
    } else {
      let blank = true;
      for (let x = last + 1; x < w; x++) {
        const i = base + x;
        if (back.chars[i] !== 0x20 || back.styles[i] !== 0 || back.widths[i] !== 1) {
          blank = false;
          break;
        }
      }
      out.tailBlank[y] = blank ? 1 : 0;
    }
  }
}

/** 格是否空白（空格 + 缺省样式 + 宽 1——与 CellBuffer 初始态同构） */
function backIsBlank(back: CellBuffer, i: number): boolean {
  return back.chars[i] === 0x20 && back.styles[i] === 0 && back.widths[i] === 1;
}

/**
 * 稀疏面整字素比对（遗漏大扫 20260903 desktop D3-1）：同格同首码点不同字素
 * （👨‍👩→👨‍👨 同首码点 U+1F468）三数组全等但呈现不同——Map 双查比对全文；
 * 两侧皆无项 = 单码点格，三数组已裁决（真——读路径零分配）。
 */
function sameMultiGrapheme(front: CellBuffer, back: CellBuffer, i: number): boolean {
  const a = front.multiAt(i);
  const b = back.multiAt(i);
  return a === undefined && b === undefined ? true : a === b;
}

/** 样式字 → SGR 参数序列（与 cell.ts packStyle 位域对齐；0 参数 = 全复位） */
function sgrParams(word: number): string {
  if (word === 0) return '0';
  const parts: string[] = [];
  // 属性位（与 cell.ts 位序一致——1 bold/2 dim/3 italic/4 underline/7 reverse）
  if (word & 0b1) parts.push('1');
  if (word & 0b10) parts.push('2');
  if (word & 0b100) parts.push('3');
  if (word & 0b1000) parts.push('4');
  if (word & 0b10000) parts.push('7');
  const fg = (word >> 8) & 0xff;
  const bg = (word >> 16) & 0xff;
  // 调色板编码：1-8 标准色（30/40 + n-1）；9-16 亮色（90/100 + n-9）
  if (fg > 0) parts.push(fg <= 8 ? String(29 + fg) : String(80 + fg));
  if (bg > 0) parts.push(bg <= 8 ? String(39 + bg) : String(90 + bg));
  return parts.join(';');
}

/**
 * 把行差分渲染成 ANSI 内容段（2026 包裹与光标段由引擎组装）。
 * @param back 内容侧（本帧结果缓冲）
 * @param diff diffRows 产出（forceFull 时忽略）
 * @param forceFull true = 全量写（首帧/换防重进/resize——行级 EL 清行语义）
 * @returns ANSI 文本（无变更且非强制 = 空串——按需渲染的零写出面）
 */
export function writeDiff(back: CellBuffer, diff: RowDiff, forceFull: boolean): string {
  const parts: string[] = [];
  const w = back.width;
  let any = false;
  // 光标落位追踪（免跳判据）与已发样式字（同款样式零冗余 SGR）
  let curX = -1;
  let curY = -1;
  let curStyle = -1;

  /** 样式变迁才发 SGR（闭包只碰 parts/curStyle——帧级分配，非热路径） */
  const setStyle = (styleWord: number): void => {
    if (styleWord !== curStyle) {
      parts.push(`\x1b[${sgrParams(styleWord)}m`);
      curStyle = styleWord;
    }
  };

  /** 行内 [first, last] 连写：续格跳过（内容随首格）、宽字符一次跨两列 */
  const writeSpan = (y: number, first: number, last: number): void => {
    let x = first;
    while (x <= last) {
      const i = y * w + x;
      const width = back.widths[i];
      if (width === 0) {
        x++; // 续格：首格写出已覆盖本列
        continue;
      }
      setStyle(back.styles[i]!);
      const multi = back.multiAt(i);
      parts.push(multi !== undefined ? multi : String.fromCodePoint(back.chars[i]!));
      x += width!;
    }
    curX = x; // 写完后的期望光标列（含 pending-wrap 态——下行必发 CUP，不依赖它）
    curY = y;
  };

  for (let y = 0; y < back.height; y++) {
    if (forceFull) {
      // 全量行：last = 最右非空白格（空白 = 空格+缺省样式+宽 1）；全空白行仅清行
      let last = -1;
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (back.chars[i] !== 0x20 || back.styles[i] !== 0 || back.widths[i] !== 1) {
          last = x;
          break;
        }
      }
      any = true;
      parts.push(`\x1b[${y + 1};1H`);
      if (last < 0) {
        setStyle(0); // EL 以当前背景擦除（BCE）——先复位缺省再清
        parts.push('\x1b[K');
        curX = 0;
        curY = y;
        continue;
      }
      writeSpan(y, 0, last);
      if (last < w - 1) {
        // 行尾存在空白段（由 last 定义保证）→ EL 洗净终端残迹（禁空格填充）；
        // last = w-1 时无尾段可清且写末列已入 pending-wrap——不发 EL 防误擦末格
        setStyle(0);
        parts.push('\x1b[K');
      }
      continue;
    }
    const first = diff.first[y]!;
    let last = diff.last[y]!;
    if (last < 0) continue; // 无变更行零写出（增量性）
    any = true;
    // EL 尾清行前先收缩尾端空白变更格：变更尾若已是空白（前帧有残迹），交给
    // EL 洗——不写字面空格（禁空格填充的增量侧落位；全空白段收缩到仅 CUP+EL）
    if (diff.tailBlank[y] === 1) {
      while (last > first && backIsBlank(back, y * w + last)) last--;
    }
    if (!(curY === y && curX === first)) {
      parts.push(`\x1b[${y + 1};${first + 1}H`);
    }
    writeSpan(y, first, last);
    if (diff.tailBlank[y] === 1 && last < w - 1) {
      // 增量清行尾：back 尾段全空白且前帧该区间有残迹（diff 已含其变更）→ EL
      setStyle(0);
      parts.push('\x1b[K');
    }
  }
  if (!any) return '';
  return parts.join('');
}
