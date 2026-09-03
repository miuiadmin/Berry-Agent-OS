/**
 * cell 网格缓冲（十一律第 1/2/6 条）：屏幕 = 打包 TypedArray 三件套
 * （码点/样式/列宽），渲染路径零对象分配（无 Cell 对象、热路径无 Map 写入）。
 * - `chars: Uint32Array`：每格一个码点；宽字符占两格——首格存码点、次格存
 *   CONTINUATION（与 xterm 的 width-0 续格同构，差分比较直接按格比）。
 * - `styles: Uint32Array`：打包样式字（属性位 + fg/bg 调色板索引）。
 * - `widths: Uint8Array`：每格列宽（0=续格/1/2）。
 * - 稀疏 Map 只服务多码点字素（ZWJ 序列/旗帜——整字素存首格），静态内容写完
 *   即不再碰：渲染路径不触发分配。
 *
 * 双缓冲（ping-pong）由引擎持有：front = 屏上真相（差分基线），back = 本帧
 * 渲染目标；resize 才重分配（帧路径复用同两块内存——零分配纪律的落点）。
 */
import type { Area, CellBuffer as ICellBuffer, Style } from './types.js';
import { codePointWidth, graphemesOf } from './width.js';

/** 续格标记（宽字符第二格的 chars 值——0 是合法码点 NUL，故用特异值） */
export const CONTINUATION = 0xffffffff;

/** 空格码点（空白格的标准内容） */
const SPACE = 0x20;

/** 样式打包位域：bit0-4 属性 / bit8-15 fg 调色板 / bit16-23 bg 调色板 */
const BOLD = 1 << 0;
const DIM = 1 << 1;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;
const REVERSE = 1 << 4;

/** Style → 32 位样式字（0 = 全缺省——差分零初始化的直接收益） */
export function packStyle(style: Style | undefined): number {
  if (!style) return 0;
  let word = 0;
  if (style.bold) word |= BOLD;
  if (style.dim) word |= DIM;
  if (style.italic) word |= ITALIC;
  if (style.underline) word |= UNDERLINE;
  if (style.reverse) word |= REVERSE;
  // 调色板索引落位（括号必须——& 优先级低于 <<；0 = 缺省色）
  word |= ((style.fg ?? 0) & 0xff) << 8;
  word |= ((style.bg ?? 0) & 0xff) << 16;
  return word;
}

/** 32 位样式字 → Style（测试与断言面用；渲染路径不用） */
export function unpackStyle(word: number): Style {
  return {
    fg: (word >> 8) & 0xff,
    bg: (word >> 16) & 0xff,
    bold: (word & BOLD) !== 0,
    dim: (word & DIM) !== 0,
    italic: (word & ITALIC) !== 0,
    underline: (word & UNDERLINE) !== 0,
    reverse: (word & REVERSE) !== 0,
  };
}

/**
 * cell 缓冲实现（types.ts CellBuffer 协议的具象类）。
 * 引擎双缓冲各持一块；Renderable 只经 setCell/writeString/fill 写。
 */
export class CellBuffer implements ICellBuffer {
  readonly width: number;
  readonly height: number;
  /** 每格码点（宽字符次格 = CONTINUATION；空白格 = SPACE） */
  readonly chars: Uint32Array;
  /** 每格打包样式字（0 = 缺省） */
  readonly styles: Uint32Array;
  /** 每格列宽（0 = 续格） */
  readonly widths: Uint8Array;
  /** 多码点字素稀疏面：格下标 → 完整字素串（ZWJ/旗帜）。写串时置、覆盖时清 */
  private readonly graphemeMap = new Map<number, string>();
  /** 本帧光标声明（null = 无可见光标；引擎帧尾统一落位） */
  private cursorPos: { x: number; y: number } | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.chars = new Uint32Array(width * height).fill(SPACE);
    this.styles = new Uint32Array(width * height);
    this.widths = new Uint8Array(width * height).fill(1);
  }

  /** 行内下标（越界格返回 -1——写路径统一静默吸收） */
  private index(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  /** 清成空白画布（整格空格 + 缺省样式；graphemeMap 同步清空） */
  clear(): void {
    this.chars.fill(SPACE);
    this.styles.fill(0);
    this.widths.fill(1);
    this.graphemeMap.clear();
  }

  setCell(x: number, y: number, codePoint: number, style?: Style): void {
    const i = this.index(x, y);
    if (i < 0) return;
    const w = codePoint === CONTINUATION ? 0 : codePointWidth(codePoint);
    // 覆写前摘除旧格字素痕迹（首格 → 删稀疏面引用）
    this.clearCellTrace(i);
    this.chars[i] = codePoint;
    this.styles[i] = packStyle(style);
    this.widths[i] = w;
    if (w === 2) {
      // 宽字符：右邻格补续格（右邻在界内才补；行末截断允许丢右半——写路径纪律）
      const j = this.index(x + 1, y);
      if (j >= 0) {
        this.clearCellTrace(j);
        this.chars[j] = CONTINUATION;
        this.styles[j] = this.styles[i]; // 续格携带同款样式（整字观感一致）
        this.widths[j] = 0;
      }
    }
  }

  /** 摘除格上旧字素痕迹（首格 → 删 Map 项；续格无 Map 引用，无需动作） */
  private clearCellTrace(i: number): void {
    if (this.widths[i] === 0) return; // 续格：其首格的清理路径自会处理
    if (this.graphemeMap.has(i)) this.graphemeMap.delete(i);
  }

  /** 写整段文本（按字素落位；多码点字素存稀疏面；右边界整字截断） */
  writeString(x: number, y: number, text: string, style?: Style): void {
    const packed = packStyle(style);
    let cx = x;
    for (const g of graphemesOf(text)) {
      const i = this.index(cx, y);
      if (i < 0) return; // 出界即止（截断）
      const w = g.width;
      if (cx + w > this.width) return; // 宽字符行末整字截断（第二列不悬挂）
      this.clearCellTrace(i);
      this.chars[i] = g.firstCodePoint;
      this.styles[i] = packed;
      this.widths[i] = w;
      if (g.segment.length > 1) this.graphemeMap.set(i, g.segment); // 多码点字素
      if (w === 2) {
        const j = this.index(cx + 1, y);
        this.clearCellTrace(j);
        this.chars[j] = CONTINUATION;
        this.styles[j] = packed;
        this.widths[j] = 0;
      }
      cx += w;
    }
  }

  /** 区域填充（空格 + 样式；宽字符残留通过逐格覆写自然洗净） */
  fill(area: Area, style?: Style): void {
    const packed = packStyle(style);
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        const i = this.index(x, y);
        if (i < 0) continue;
        this.clearCellTrace(i);
        this.chars[i] = SPACE;
        this.styles[i] = packed;
        this.widths[i] = 1;
      }
    }
  }

  /** 取格内容快照（差分测试/断言面；渲染路径不走） */
  cellAt(x: number, y: number): { chars: string; styleWord: number; width: number } | null {
    const i = this.index(x, y);
    if (i < 0) return null;
    const c = this.chars[i]!;
    const chars = c === CONTINUATION ? '' : (this.graphemeMap.get(i) ?? String.fromCodePoint(c));
    return { chars, styleWord: this.styles[i]!, width: this.widths[i]! };
  }

  /** 格下标 → 多码点字素全文（无则 undefined；差分写出器整字素取回用） */
  multiAt(i: number): string | undefined {
    return this.graphemeMap.get(i);
  }

  /** 稀疏面是否非空（遗漏大扫 20260903 desktop D3-1：差分热路径开关——两侧图
   * 全空的屏幕（绝大多数帧）零 Map 查询开销；任一侧有字素才逐格追加全文比对） */
  hasGraphemes(): boolean {
    return this.graphemeMap.size !== 0;
  }

  /** 声明本帧可见光标（输入框等交互件 render 内调用） */
  setCursor(x: number, y: number): void {
    this.cursorPos = { x, y };
  }

  /** 撤销光标声明（失焦/无交互件帧） */
  clearCursor(): void {
    this.cursorPos = null;
  }

  /** 当前光标声明（null = 本帧无可见光标） */
  get cursor(): { x: number; y: number } | null {
    return this.cursorPos;
  }

  /** 两缓冲逐格相等性（差分单元测试面；引擎帧路径用 diff.ts 的更高效形态） */
  equals(other: CellBuffer): boolean {
    if (this.width !== other.width || this.height !== other.height) return false;
    for (let i = 0; i < this.chars.length; i++) {
      if (this.chars[i] !== other.chars[i] || this.styles[i] !== other.styles[i] || this.widths[i] !== other.widths[i])
        return false;
    }
    // 稀疏面差异不影响屏幕呈现（同码点同格即可）——不比较 graphemeMap
    return true;
  }
}
