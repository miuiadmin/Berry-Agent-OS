/**
 * 组件层（十一律第 4/5 条）：h() 函数式构造 + Column/Flex/Row/Inset 四组合子
 * （**无约束求解器**——固定子按 desiredHeight 定高、Flex 子均分余量）+
 * Text/Paragraph 文本件 + SingleLineInput 单行输入框（供批 C 桌面底部输入框）。
 *
 * 无 React/vdom/调和器——组件 = 工厂函数/类实例，render 直写 cell 缓冲，
 * 状态由持有方（shell）自管（引擎零业务智能）。
 */
import { CellBuffer } from './cell.js';
import type { Area, FlexRenderable, Renderable, Style } from './types.js';
import { graphemesOf, truncateToWidth, wrapGraphemes } from './width.js';

/**
 * h() 函数式构造（十一律第 5 条）：`h(Column, { children: [...] })`。
 * 组件 = 构造器；无 reconciliation——每次 h 都是新实例，静态内容天然「已完成
 * 即静态」（律 6 的组件侧配合）。
 */
export function h<C extends new (props: P) => Renderable, P>(ctor: C, props: P): InstanceType<C> {
  // 断言：构造器即组件工厂（约束已保 Renderable 形状；具体实例型由 C 推导）
  return new ctor(props) as InstanceType<C>;
}

/** Flex 结构判据（isFlex 真值 = Column 吸收余量子项） */
export function isFlexRenderable(r: Renderable): r is FlexRenderable {
  return (r as { isFlex?: boolean }).isFlex === true;
}

/** 区域取交（越界返回 null——布局夹取的公共件） */
function intersect(a: Area, b: Area): Area | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/* ------------------------------------------------------------------ */
/* 文本件                                                               */
/* ------------------------------------------------------------------ */

/** Text props：单行不换行文本（超宽截断——顶栏片段等静态行） */
export interface TextProps {
  content: string;
  style?: Style;
}

/** 单行文本件（desiredHeight 恒 1；宽字符截断不产生半字） */
export class Text implements Renderable {
  private readonly content: string;
  private readonly style?: Style;

  constructor(props: TextProps) {
    this.content = props.content;
    this.style = props.style;
  }

  desiredHeight(): number {
    return 1;
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.width <= 0 || area.height <= 0) return;
    buf.writeString(area.x, area.y, truncateToWidth(this.content, area.width), this.style);
  }
}

/** Paragraph props：多行折行文本（字素整字换行——律 9） */
export interface ParagraphProps {
  content: string;
  style?: Style;
}

/** 折行文本件（显式 \n + 列宽折行；desiredHeight = 折行行数） */
export class Paragraph implements Renderable {
  private readonly content: string;
  private readonly style?: Style;

  constructor(props: ParagraphProps) {
    this.content = props.content;
    this.style = props.style;
  }

  desiredHeight(width: number): number {
    return wrapGraphemes(this.content, Math.max(1, width)).length;
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.width <= 0 || area.height <= 0) return;
    const lines = wrapGraphemes(this.content, area.width);
    for (let i = 0; i < Math.min(lines.length, area.height); i++) {
      buf.writeString(area.x, area.y + i, lines[i]!, this.style);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 四组合子                                                             */
/* ------------------------------------------------------------------ */

/** Flex 包装件（isFlex 标记——Column 吸收余量的信号） */
export class Flex implements FlexRenderable {
  readonly isFlex = true as const;
  private readonly child: Renderable;

  constructor(props: { child: Renderable }) {
    this.child = props.child;
  }

  desiredHeight(): number {
    return 1; // 协商最小占位（真高度由 Column 分配余量决定）
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.height <= 0 || area.width <= 0) return;
    this.child.render(area, buf);
  }
}

/** Column props：垂直堆叠 */
export interface ColumnProps {
  children: Renderable[];
}

/**
 * 垂直堆叠组合子：固定子按 desiredHeight(width) 定高顺排；Flex 子均分余量
 * （余数给最后一个 Flex 子）。子区域宽 = 全宽；溢出截断。
 */
export class Column implements Renderable {
  private readonly children: Renderable[];

  constructor(props: ColumnProps) {
    this.children = props.children;
  }

  desiredHeight(width: number): number {
    // 协商面：固定子按各自期望；Flex 子按最小占位 1 计
    let total = 0;
    for (const c of this.children) {
      total += isFlexRenderable(c) ? 1 : Math.max(1, c.desiredHeight(width));
    }
    return Math.max(1, total);
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.width <= 0 || area.height <= 0) return;
    // 两遍：先算固定高合计与 Flex 子数，再逐子分配渲染
    const fixed: number[] = [];
    let fixedSum = 0;
    let flexCount = 0;
    for (const c of this.children) {
      if (isFlexRenderable(c)) {
        fixed.push(-1);
        flexCount++;
      } else {
        const hgt = Math.max(1, c.desiredHeight(area.width));
        fixed.push(hgt);
        fixedSum += hgt;
      }
    }
    const remaining = Math.max(0, area.height - fixedSum);
    const flexH = flexCount > 0 ? Math.max(1, Math.floor(remaining / flexCount)) : 0;
    let flexSeen = 0;
    let y = area.y;
    for (let idx = 0; idx < this.children.length; idx++) {
      if (y >= area.y + area.height) break; // 底部溢出截断
      const child = this.children[idx]!;
      let hgt: number;
      if (fixed[idx]! < 0) {
        flexSeen++;
        // 末 Flex 子收整除余数（份额 = 余量 - 前 N-1 份），仍受底部截断约束
        const share = flexSeen === flexCount ? remaining - flexH * (flexCount - 1) : flexH;
        hgt = Math.min(Math.max(0, share), area.y + area.height - y);
      } else {
        hgt = Math.min(fixed[idx]!, area.y + area.height - y);
      }
      if (hgt > 0) {
        child.render({ x: area.x, y, width: area.width, height: hgt }, buf);
      }
      y += hgt;
    }
  }
}

/** Row props：水平分列（weights 缺省等权） */
export interface RowProps {
  children: Renderable[];
  /** 各子权重（缺省全 1——等分） */
  weights?: number[];
}

/** 水平分列组合子：按权重分宽（整除余数给末列）；高度 = 各子期望最大值 */
export class Row implements Renderable {
  private readonly children: Renderable[];
  private readonly weights: number[];

  constructor(props: RowProps) {
    this.children = props.children;
    this.weights = props.weights ?? props.children.map(() => 1);
  }

  /** 在总宽 width 下各子分得的列宽（含余数吸收——render 与协商共用单源） */
  private allocate(width: number): number[] {
    const totalW = this.weights.reduce((a, b) => a + b, 0);
    const out: number[] = [];
    let used = 0;
    for (let i = 0; i < this.children.length; i++) {
      const w = i === this.children.length - 1 ? width - used : Math.floor((width * (this.weights[i] ?? 1)) / totalW);
      out.push(Math.max(0, w));
      used += Math.max(0, w);
    }
    return out;
  }

  desiredHeight(width: number): number {
    const widths = this.allocate(Math.max(1, width));
    let max = 1;
    for (let i = 0; i < this.children.length; i++) {
      max = Math.max(max, this.children[i]!.desiredHeight(Math.max(1, widths[i]!)));
    }
    return max;
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.width <= 0 || area.height <= 0) return;
    const widths = this.allocate(area.width);
    let x = area.x;
    for (let i = 0; i < this.children.length; i++) {
      if (x >= area.x + area.width) break; // 右侧溢出截断
      if (widths[i]! > 0) {
        this.children[i]!.render({ x, y: area.y, width: widths[i]!, height: area.height }, buf);
      }
      x += widths[i]!;
    }
  }
}

/** Inset props：内缩边距 */
export interface InsetProps {
  child: Renderable;
  /** 上边距（行） */
  top?: number;
  /** 右边距（列） */
  right?: number;
  /** 下边距（行） */
  bottom?: number;
  /** 左边距（列） */
  left?: number;
}

/** 内缩组合子：区域四向收缩后整交子件 */
export class Inset implements Renderable {
  private readonly child: Renderable;
  private readonly top: number;
  private readonly right: number;
  private readonly bottom: number;
  private readonly left: number;

  constructor(props: InsetProps) {
    this.child = props.child;
    this.top = props.top ?? 0;
    this.right = props.right ?? 0;
    this.bottom = props.bottom ?? 0;
    this.left = props.left ?? 0;
  }

  desiredHeight(width: number): number {
    return Math.max(1, this.child.desiredHeight(Math.max(1, width - this.left - this.right))) + this.top + this.bottom;
  }

  render(area: Area, buf: CellBuffer): void {
    const inner: Area = {
      x: area.x + this.left,
      y: area.y + this.top,
      width: Math.max(0, area.width - this.left - this.right),
      height: Math.max(0, area.height - this.top - this.bottom),
    };
    const clipped = intersect(inner, area);
    if (!clipped) return;
    this.child.render(clipped, buf);
  }
}

/* ------------------------------------------------------------------ */
/* 单行输入框（批 C 桌面底部输入框的引擎级交付件）                          */
/* ------------------------------------------------------------------ */

/** SingleLineInput props */
export interface SingleLineInputProps {
  /** 前缀提示（如 '> '） */
  prompt?: string;
  /** 正文样式 */
  style?: Style;
  /** 前缀样式 */
  promptStyle?: Style;
  /** 焦点态（true = 渲染光标；失焦不落光标） */
  focused?: boolean;
  /** 预编辑样式（IME 组字下划线——缺省 underline 开） */
  preeditStyle?: Style;
}

/**
 * 单行输入框 Renderable：光标/插入/删除/左右移动/首页尾页 + CJK 双宽光标对齐
 * + IME 预编辑渲染 + 水平滚动（光标恒可视）。
 *
 * 状态面（text/cursor/preedit）由持有方经方法驱动；desiredHeight 恒 1。
 * 光标列 = 前缀宽 + 光标前字素列宽和——宽字符光标落其首列（双宽对齐）。
 */
export class SingleLineInput implements Renderable {
  /** 正文（字符串态；字素切分在渲染/移动时进行） */
  private content = '';
  /** 光标字素下标（0..字素数） */
  private cursorIdx = 0;
  /** IME 预编辑（null = 无组字） */
  private preedit: string | null = null;
  private readonly prompt: string;
  private readonly style?: Style;
  private readonly promptStyle?: Style;
  private readonly preeditStyle: Style;
  focused: boolean;

  constructor(props: SingleLineInputProps = {}) {
    this.prompt = props.prompt ?? '';
    this.style = props.style;
    this.promptStyle = props.promptStyle;
    this.focused = props.focused ?? true;
    this.preeditStyle = props.preeditStyle ?? { underline: true };
  }

  /** 当前正文 */
  get text(): string {
    return this.content;
  }

  /** 当前光标字素下标 */
  get cursor(): number {
    return this.cursorIdx;
  }

  /** 挂起预编辑（IME 组字渲染面） */
  get pendingPreedit(): string | null {
    return this.preedit;
  }

  /** 整体设值（光标归尾） */
  setText(text: string): void {
    this.content = text;
    this.cursorIdx = graphemesOf(text).length;
  }

  /** 清空（光标归零） */
  clear(): void {
    this.content = '';
    this.cursorIdx = 0;
  }

  /** 在光标处插入文本（IME 提交/普通输入共用路） */
  insertText(text: string): void {
    if (text.length === 0) return;
    // 串路直拼（第九轮 #5 修死）：修前 graphemesOf(text) 的 N 元素 spread 进
    // splice 触 V8 实参栈上限（~12 万——150KB 粘贴即 RangeError 未捕获杀整
    // 进程）。改为光标位切前后串直接拼接，元素计数另算（光标仍按字素位推进）
    const gs = graphemesOf(this.content);
    const before = gs
      .slice(0, this.cursorIdx)
      .map((g) => g.segment)
      .join('');
    const after = gs
      .slice(this.cursorIdx)
      .map((g) => g.segment)
      .join('');
    this.content = before + text + after;
    this.cursorIdx += graphemesOf(text).length;
  }

  /** 设置/清除 IME 预编辑（组字中间态——渲染为下划线段，不并入正文） */
  setPreedit(text: string | null): void {
    this.preedit = text !== null && text.length > 0 ? text : null;
  }

  /** 退格（删光标前一字素；行首无操作） */
  backspace(): void {
    if (this.cursorIdx === 0) return;
    const gs = graphemesOf(this.content);
    gs.splice(this.cursorIdx - 1, 1);
    this.content = gs.map((g) => g.segment).join('');
    this.cursorIdx--;
  }

  /** 前删（删光标处字素；行尾无操作） */
  deleteForward(): void {
    const gs = graphemesOf(this.content);
    if (this.cursorIdx >= gs.length) return;
    gs.splice(this.cursorIdx, 1);
    this.content = gs.map((g) => g.segment).join('');
  }

  /** 左移一字素（宽字符一步跨双列——字素级移动永不入半字） */
  moveLeft(): void {
    if (this.cursorIdx > 0) this.cursorIdx--;
  }

  /** 右移一字素 */
  moveRight(): void {
    if (this.cursorIdx < graphemesOf(this.content).length) this.cursorIdx++;
  }

  /** 光标归首 */
  moveHome(): void {
    this.cursorIdx = 0;
  }

  /** 光标归尾 */
  moveEnd(): void {
    this.cursorIdx = graphemesOf(this.content).length;
  }

  desiredHeight(): number {
    return 1;
  }

  render(area: Area, buf: CellBuffer): void {
    if (area.width <= 0 || area.height <= 0) return;
    const promptSegs = graphemesOf(this.prompt);
    const promptW = promptSegs.reduce((a, g) => a + g.width, 0);
    const textSegs = graphemesOf(this.content);
    const preeditSegs = this.preedit !== null ? graphemesOf(this.preedit) : [];
    // 光标前文本的列宽和（双宽对齐锚）；预编辑在场时光标在预编辑尾
    let beforeCursor = promptW;
    for (let i = 0; i < this.cursorIdx && i < textSegs.length; i++) {
      beforeCursor += textSegs[i]!.width;
    }
    for (const g of preeditSegs) beforeCursor += g.width;

    // 水平滚动：光标列必须落在 [0, area.width)——溢出时右端锚定
    let startCol = 0;
    if (beforeCursor >= area.width) {
      startCol = beforeCursor - area.width + 1;
    }
    // 从 startCol 起画：先跳过 prompt/text 的前列，逐字素落位
    let col = 0;
    const drawSegs = (segs: { segment: string; width: number }[], style: Style | undefined): void => {
      for (const g of segs) {
        if (col >= startCol + area.width) return;
        if (col + g.width > startCol + area.width) return; // 宽字符右缘整字截断
        if (col >= startCol) {
          buf.writeString(area.x + (col - startCol), area.y, g.segment, style);
        }
        col += g.width;
      }
    };
    drawSegs(promptSegs, this.promptStyle);
    drawSegs(textSegs, this.style);
    drawSegs(preeditSegs, this.preeditStyle);

    // 光标声明：焦点态 + 光标列可视时落位（宽字符光标在其首列）
    if (this.focused) {
      const cursorCol = beforeCursor - startCol;
      if (cursorCol >= 0 && cursorCol < area.width) {
        buf.setCursor(area.x + cursorCol, area.y);
      }
    }
  }
}
