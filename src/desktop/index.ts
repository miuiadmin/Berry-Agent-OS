/**
 * desktop 引擎公共面（模块席 28；技术栈篇 §4.5 十一律 + 契约篇 §6.11）。
 *
 * 桶导出：契约类型（types）/ 引擎（engine）/ 差分与缓冲（cell + diff）/ 输入
 * 解码（input）/ CJK 双件（width）/ 组件层（components）。
 * 拓扑边为空（引擎零兄弟依赖）；消费方（批 C desktop 件）一律经本面 import。
 */

/* 契约类型（CellBuffer 接口面的具象类见下方 cell 导出——同名类满足接口） */
export type {
  Area,
  Style,
  Renderable,
  FlexRenderable,
  KeyModifiers,
  KeyEvent,
  TextEvent,
  ImeEvent,
  PasteEvent,
  InputEvent,
  KeyboardProtocol,
  TerminalIO,
  EngineEventMap,
  DesktopEngineOptions,
} from './types.js';

/* 引擎本体（帧调度/按需渲染/换防收口面） */
export { DesktopEngine } from './engine.js';

/* cell 缓冲与差分写出（CellBuffer 协议具象 + 行差分 + ANSI 内容段） */
export { CellBuffer, CONTINUATION, packStyle, unpackStyle } from './cell.js';
export { createRowDiff, diffRows, writeDiff, type RowDiff } from './diff.js';

/* 输入解码器（kitty/legacy 双轨 + IME 组字态 + bracketed paste） */
export { InputDecoder, type InputDecoderOptions } from './input.js';

/* CJK 双件（列宽唯一真相源 + 字素边界） */
export {
  codePointWidth,
  graphemesOf,
  stringWidth,
  truncateToWidth,
  wrapGraphemes,
  type GraphemeSegment,
} from './width.js';

/* 组件层（h() + Column/Flex/Row/Inset + Text/Paragraph + 单行输入框） */
export {
  h,
  isFlexRenderable,
  Text,
  Paragraph,
  Flex,
  Column,
  Row,
  Inset,
  SingleLineInput,
  type TextProps,
  type ParagraphProps,
  type ColumnProps,
  type RowProps,
  type InsetProps,
  type SingleLineInputProps,
} from './components.js';
