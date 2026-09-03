/**
 * CJK 双件（十一律第 9 条）：**列宽与字素是两个问题，两件各司其职**。
 * - 列宽（占几个终端格）：get-east-asian-width 的 eastAsianWidthType 是唯一
 *   真相源（wide/fullwidth = 2 列，其余 1 列；ambiguous 按 1 列——中西混排终端
 *   语境的通用取舍）。
 * - 字素（用户感知的字符边界）：Intl.Segmenter(grapheme)——emoji ZWJ 序列/
 *   旗帜（Regional Indicator 对）/变体选择子永不撕裂。
 * - 断行 = 字素整字换行（宽字符第二列不悬挂：剩余 1 列遇宽字符整字下移）。
 *
 * OpenCode 反课：只用 Segmenter 不管宽度 → CJK 断行错位至今未修——本文件两件
 * 同时在场即律 9 的落位。
 */
import { eastAsianWidthType } from 'get-east-asian-width';

/** 单码点列宽（wide/fullwidth = 2；其余含 ambiguous = 1） */
export function codePointWidth(codePoint: number): number {
  const t = eastAsianWidthType(codePoint);
  // wide（CJK 统一表意文字等「W」类）与 fullwidth（「F」类）占 2 列；
  // halfwidth/neutral/ambiguous 一律 1 列（ambiguous 语境取舍——注释在案）
  return t === 'wide' || t === 'fullwidth' ? 2 : 1;
}

/** 字素段（Intl.Segmenter 的最小产出——segment 字符串 + 首码点 + 字素级列宽） */
export interface GraphemeSegment {
  /** 字素全文（可能多码点：ZWJ 序列/旗帜/变体选择子组合） */
  segment: string;
  /** 字素首码点（cell 写入锚——稀疏面以首格存整字素） */
  firstCodePoint: number;
  /** 该字素占的列数（1 或 2——graphemeWidthOf 字素级裁决） */
  width: number;
}

/** 模块级 Segmenter 单例（构造贵；locale 无关 + grapheme 粒度） */
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Regional Indicator 码点区间（旗帜 = 一对 RI 构成一双宽字素） */
const RI_MIN = 0x1f1e6;
const RI_MAX = 0x1f1ff;
/** VS16（emoji 呈现选择子——伴生基字符按双宽呈现） */
const VS16 = 0xfe0f;

/**
 * 字素级列宽（律 9 的真裁决点——字素为最小呈现单位）：
 * 1. 字素内任一码点 wide/fullwidth → 2（CJK/全角标点/emoji 本体/ZWJ 家族）；
 * 2. 含 VS16（emoji 呈现）→ 2（❤️/键帽序等）；
 * 3. 恰一对 Regional Indicator（旗帜 🇨🇳）→ 2（EAW 属性 Neutral 但终端双宽——
 *    单码点宽度模型覆盖不到的字形，字素级特判）；
 * 4. 其余 → 1。
 */
function graphemeWidthOf(segment: string): number {
  let riCount = 0;
  let cpIdx = 0;
  while (cpIdx < segment.length) {
    const cp = segment.codePointAt(cpIdx)!;
    if (cp >= RI_MIN && cp <= RI_MAX) riCount++;
    if (cp === VS16) return 2; // 规则 2 提前出
    const t = eastAsianWidthType(cp);
    if (t === 'wide' || t === 'fullwidth') return 2; // 规则 1 提前出
    cpIdx += cp > 0xffff ? 2 : 1;
  }
  if (riCount === 2) return 2; // 规则 3：旗帜
  return 1;
}

/**
 * 把字符串切成字素段数组（渲染与断行的公共前置）。
 * 零宽连接符/变体选择子等扩展码点并入前一字素——「用户感知字符永不撕裂」。
 */
export function graphemesOf(text: string): GraphemeSegment[] {
  const out: GraphemeSegment[] = [];
  for (const { segment } of segmenter.segment(text)) {
    out.push({ segment, firstCodePoint: segment.codePointAt(0)!, width: graphemeWidthOf(segment) });
  }
  return out;
}

/** 字符串总列宽（= 各字素宽度和；空串 0） */
export function stringWidth(text: string): number {
  let w = 0;
  for (const g of graphemesOf(text)) w += g.width;
  return w;
}

/** 宽度裁剪：保留前 maxColumns 列（宽字符跨界整字丢弃——不产生半字） */
export function truncateToWidth(text: string, maxColumns: number): string {
  let w = 0;
  let out = '';
  for (const g of graphemesOf(text)) {
    if (w + g.width > maxColumns) break;
    out += g.segment;
    w += g.width;
  }
  return out;
}

/**
 * 字素整字换行（十一律第 9 条断行规则）：按列宽把文本折成行。
 * - 显式 '\n' 强制换行；
 * - 行内放不下下一个字素时换行（宽字符剩 1 列 → 整字下移，第二列不悬挂）。
 * 返回行数组（每行为原文本切片拼接，无插入或拆分）。
 */
export function wrapGraphemes(text: string, width: number): string[] {
  if (width <= 0) return ['']; // 零宽退化为单空行（防御——布局层不传 0）
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const g of graphemesOf(text)) {
    if (g.segment === '\n') {
      // 显式换行：当前行封口（'\n' 本身不占格）
      lines.push(cur);
      cur = '';
      curW = 0;
      continue;
    }
    if (curW + g.width > width) {
      // 放不下：封口换行（宽字符整字下移——curW+2 > 剩 1 列时在此触发）
      lines.push(cur);
      cur = g.segment;
      curW = g.width;
    } else {
      cur += g.segment;
      curW += g.width;
    }
  }
  lines.push(cur); // 尾行（含空文本时的单空行）
  return lines;
}
