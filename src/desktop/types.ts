/**
 * desktop 引擎公共契约（技术栈篇 §4.5 十一律 + 契约篇 §6.11 换防机制单源）。
 *
 * 本模块是纯渲染引擎（模块席 28）：cell 网格 → 前帧差分 → ANSI 增量写出、
 * Renderable 协议 + 四组合子、输入解码（kitty/legacy 双轨 + IME 组字态）、
 * CJK 双件（列宽 vs 字素）。零业务智能、零 durable 事件、零新表族；不 import
 * 任何兄弟模块（拓扑边为空——引擎可被任何宿主独立持有）。
 */

/** 矩形区域（列 x 行坐标系；x 向右、y 向下，原点在终端左上角） */
export interface Area {
  /** 起始列（含） */
  x: number;
  /** 起始行（含） */
  y: number;
  /** 宽度（列数） */
  width: number;
  /** 高度（行数） */
  height: number;
}

/** 单元格样式（打包进 32 位样式字——cell.ts packStyle；色域 = 16 色 ANSI + 属性位） */
export interface Style {
  /** 前景色索引（0-15；0 = 缺省前景。编码见 cell.ts） */
  fg?: number;
  /** 背景色索引（0-15；0 = 缺省背景） */
  bg?: number;
  /** 加粗 */
  bold?: boolean;
  /** 暗淡 */
  dim?: boolean;
  /** 斜体 */
  italic?: boolean;
  /** 下划线（IME 组字预编辑文本的默认标示） */
  underline?: boolean;
  /** 反色（选中态） */
  reverse?: boolean;
}

/**
 * Renderable 协议（十一律第 4 条）：两段协商。
 * - `desiredHeight(width)`：给定宽度时期望占多少行（布局协商输入——Column 给
 *   固定子分配高度、Flex 子吸收余量；无约束求解器）。
 * - `render(area, buf)`：向 cell 缓冲的给定区域写内容（越界写由 CellBuffer 吸收）。
 */
export interface Renderable {
  /** 在给定宽度下的期望高度（行数；至少 1） */
  desiredHeight(width: number): number;
  /** 把内容写进缓冲的指定区域（只写自己区域内的 cell） */
  render(area: Area, buf: CellBuffer): void;
}

/**
 * Flex 标记（十一律第 4 条）：Column 内被它包裹的子项吸收剩余高度。
 * 结构判据 = `isFlex` 属性真值（isFlexRenderable() 判别，components.ts）。
 */
export interface FlexRenderable extends Renderable {
  readonly isFlex: true;
}

/** cell 缓冲协议（Renderable 写入面；实现见 cell.ts——打包 TypedArray 零对象分配） */
export interface CellBuffer {
  /** 网格宽（列数） */
  readonly width: number;
  /** 网格高（行数） */
  readonly height: number;
  /** 在 (x, y) 写一个字符（宽字符自动占两格并补 continuation；越界静默忽略） */
  setCell(x: number, y: number, codePoint: number, style?: Style): void;
  /** 在 (x, y) 起写一段文本（按字素与列宽逐格落位；遇右边界截断） */
  writeString(x: number, y: number, text: string, style?: Style): void;
  /** 用空格 + 样式填充整个区域 */
  fill(area: Area, style?: Style): void;
  /** 声明本帧可见光标位置（输入框等交互件在 render 内调用；引擎帧尾统一落光标） */
  setCursor(x: number, y: number): void;
  /** 撤销光标声明（失焦/无交互件帧） */
  clearCursor(): void;
  /** 当前光标声明（null = 本帧无可见光标） */
  readonly cursor: { x: number; y: number } | null;
}

/** 修饰键集合（kitty 修饰位解码结果；legacy 轨只有 ctrl/alt/shift 可靠） */
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** super/meta（kitty 轨可得；legacy 轨恒 false） */
  meta: boolean;
}

/** 键事件（非文本键 + kitty 轨全量键；key 用规范键名——见 input.ts） */
export interface KeyEvent {
  kind: 'key';
  /** 规范键名：'a'..'z'/'0'..'9'/可打印字符，或 'enter'/'escape'/'backspace'/'tab'/'left'/'right'/'up'/'down'/'home'/'end'/'delete'/'insert'/'pageup'/'pagedown'/'f1'..'f12' */
  key: string;
  /** 修饰键状态 */
  mods: KeyModifiers;
  /** kitty 轨事件类型（press 缺省；repeat/release 仅终端上报时出现） */
  eventType?: 'press' | 'repeat' | 'release';
}

/** 文本事件（legacy 轨普通打字 + kitty 轨 CSI u 文本字段提交） */
export interface TextEvent {
  kind: 'text';
  text: string;
}

/**
 * IME 事件（十一律第 7 条 IME 一等公民）。
 * - `composing: true`：组字进行中（预编辑增量）——**不派发给焦面**（key/text
 *   消费者永远看不到），仅供预编辑渲染面订阅；组字中间态绝不落为正文。
 * - `composing: false`：组字提交（上屏文本）——按正文交付。
 */
export interface ImeEvent {
  kind: 'ime';
  /** true = 组字中（预编辑增量）；false = 提交 */
  composing: boolean;
  /** 预编辑全文（composing 时）或提交文本（composing false 时） */
  text: string;
}

/** 粘贴事件（bracketed paste 整段交付——\x1b[200~/201~ 包裹序完整识别） */
export interface PasteEvent {
  kind: 'paste';
  text: string;
}

/** 引擎输入事件并集（引擎 emitter 面 'input' 信道的载荷） */
export type InputEvent = KeyEvent | TextEvent | ImeEvent | PasteEvent;

/** kitty 键盘协议探测结果（engine.start/resume 时探测；DA1 先到无 kitty 应答 = legacy） */
export type KeyboardProtocol = 'kitty' | 'legacy';

/**
 * 终端 IO 抽象（引擎与真 TTY 解耦的注入口；缺省适配 = process stdin/stdout）。
 * 换防三件套（契约篇 §6.11）正好落在本面四个动词上：
 * onInput(null) = removeListener；pause()；setRawMode(恢复先验态)。
 */
export interface TerminalIO {
  /** 写 ANSI 字节流（同步写出；引擎帧 flush 的唯一出口） */
  write(data: string): void;
  /** 当前列数 */
  readonly columns: number;
  /** 当前行数 */
  readonly rows: number;
  /** 设置/解除 raw 模式（挂起时恢复进入前先验态） */
  setRawMode(enabled: boolean): void;
  /** 当前 raw 态（start 时留档先验态——挂起复原的依据） */
  isRaw(): boolean;
  /** 暂停读输入（交出方三件套之二） */
  pause(): void;
  /** 恢复读输入（接收方重装后） */
  resume(): void;
  /** 装卸输入处理器（null = removeListener——交出方三件套之一） */
  onInput(handler: ((chunk: string) => void) | null): void;
  /** 装卸 resize 处理器（null = removeListener） */
  onResize(handler: (() => void) | null): void;
}

/** 引擎事件面（模块内 emitter——十一律第 8 条零 durable 事件的运行时侧通道） */
export interface EngineEventMap {
  /** 输入事件（key/text/ime/paste——ime composing 增量也在内，焦面自行过滤） */
  input: InputEvent;
  /** 尺寸变化（重分配缓冲 + 全量重绘后发出） */
  resize: { columns: number; rows: number };
  /** kitty 探测落定（legacy/kitty；探测应答到达时一次） */
  keyboardProtocol: KeyboardProtocol;
}

/** 引擎构造选项 */
export interface DesktopEngineOptions {
  /** 终端 IO 注入（缺省 = 真进程 stdin/stdout 适配器） */
  io?: TerminalIO;
  /** 帧率帽（帧间隔下限 = 1000/fpsCap ms；缺省 60——十一律第 3 条） */
  fpsCap?: number;
  /** 时钟注入（缺省 Date.now；测试假钟） */
  now?: () => number;
  /** 帧调度注入（缺省真 setTimeout；测试假钟。返回句柄供取消） */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** 取消调度（与 schedule 成对） */
  cancelSchedule?: (handle: unknown) => void;
  /** lone-ESC 判定窗（ms；缺省 30——窗内无续字节即判 Esc 键） */
  escapeWindowMs?: number;
}
