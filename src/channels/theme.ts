/**
 * L4 channels — accent 着色原语（契约篇 §5.4 theme 渲染轻件——2026-08-30 D4 落码）。
 *
 * 着色唯一发生点 = 通道壳（render 展示行恒纯文本零 ANSI——render.ts 头注纪律）：
 * 本文件持有 白名单色名→RGB 映射 + hex 解析 + truecolor SGR 转译，全纯函数。
 * 色名合法性单一事实源在 contracts（ACCENT_COLOR_NAMES——schema 与本表同名同集，
 * 名字集漂移由 contracts 侧 literals 执法兜底：表外名过不了 schema，到不了这里）。
 *
 * v1 挂账（契约篇同条）：终端降级策略（truecolor 不支持时的 256 色映射）与
 * OSC 11 暗亮探测（对比度调适）皆不接——首个真实需求触发再议。
 */

import { ACCENT_COLOR_NAMES } from '../contracts/app.js';

/** RGB 三元组（0-255 各轴——truecolor 直译无量化） */
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * 白名单色名 → RGB 映射（八字与 ACCENT_COLOR_NAMES 同集；值取 Tailwind 500 系
 * ——现代终端观感基准，暗亮底都可辨）。顺序与常量一致（人读对照用，无运行时依赖）。
 */
const NAME_TO_RGB: Record<(typeof ACCENT_COLOR_NAMES)[number], Rgb> = {
  red: { r: 239, g: 68, b: 68 }, // #ef4444
  orange: { r: 249, g: 115, b: 22 }, // #f97316
  yellow: { r: 234, g: 179, b: 8 }, // #eab308
  green: { r: 34, g: 197, b: 94 }, // #22c55e
  cyan: { r: 6, g: 182, b: 212 }, // #06b6d4
  blue: { r: 59, g: 130, b: 246 }, // #3b82f6
  magenta: { r: 217, g: 70, b: 239 }, // #d946ef
  gray: { r: 156, g: 163, b: 175 }, // #9ca3af
};

/** `#rrggbb` hex 单形解析（schema 已执法单形——此处防御式解析，不合形返回 undefined） */
const parseHex = (value: string): Rgb | undefined => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 16); // exec 命中必有组 1（仓库惯例非空断言）
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

/**
 * accent 字面量 → RGB（色名查表 / hex 解析；非法返回 undefined）。
 * schema 层已拒非法字面量（APP_INVALID），此处 undefined 主要服务两路：
 * 缺省态（accent 缺席 = undefined）与防御（themeFor 回调产物未经 schema 的面）。
 */
const parseAccentColor = (accent: string): Rgb | undefined =>
  (NAME_TO_RGB as Record<string, Rgb | undefined>)[accent] ?? parseHex(accent);

/**
 * 着色函数工厂（缺省恒等律）：accent 缺席或非法 → 恒等函数（零 ANSI——零色是
 * 合法缺省态，非待修缺陷）；合法 → truecolor SGR 前缀包裹（`\x1b[38;2;r;g;b…m`）。
 * 消费面四处（状态行 ● / 编辑器边框 / 页脚 title / 非聚焦摘要行族）统一取本工厂。
 */
export function accentColorizer(accent: string | undefined): (text: string) => string {
  if (accent === undefined) return (text) => text;
  const rgb = parseAccentColor(accent);
  if (rgb === undefined) return (text) => text;
  const sgr = `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
  return (text) => `${sgr}${text}\x1b[0m`;
}
