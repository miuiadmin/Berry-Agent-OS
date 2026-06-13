/**
 * 面积图的几何计算（纯函数，无 React 依赖）。
 *
 * 把 SVG path 构建、坐标映射、Y 轴刻度从 AreaChart 组件抽出，
 * 让组件只负责渲染，数学逻辑可独立测试。
 */

/** 图表数据点 */
export interface DataPoint {
  label: string;
  value: number;
}

/** 图表内边距（SVG 坐标系） */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 默认 SVG 宽度（viewBox） */
export const SVG_WIDTH = 400;

/** 把数据点索引映射为 SVG 坐标 */
function pointToCoord(
  index: number,
  value: number,
  count: number,
  maxVal: number,
  chartWidth: number,
  chartHeight: number,
  padding: ChartPadding,
): { x: number; y: number } {
  const step = count > 1 ? chartWidth / (count - 1) : 0;
  return {
    x: padding.left + index * step,
    y: padding.top + chartHeight - (value / maxVal) * chartHeight,
  };
}

/**
 * 构建平滑曲线 path（三次贝塞尔）+ 闭合区域 path。
 *
 * @param points 数据点
 * @param maxVal 最大值（用于纵向归一化）
 * @param chartWidth / chartHeight 图表绘制区域尺寸
 * @param padding 内边距
 * @returns { line: 线条 d, area: 区域 d }；数据不足 2 点时返回空字符串
 */
export function buildSmoothPath(
  points: DataPoint[],
  maxVal: number,
  chartWidth: number,
  chartHeight: number,
  padding: ChartPadding,
): { line: string; area: string } {
  if (points.length < 2) return { line: "", area: "" };

  const coords = points.map((p, i) =>
    pointToCoord(i, p.value, points.length, maxVal, chartWidth, chartHeight, padding),
  );

  // 平滑曲线：每段用控制点 x = 中点，y = 端点 y
  let line = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const cpx = (prev.x + curr.x) / 2;
    line += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }

  // 区域 path：从基线起 → 画曲线 → 回到基线闭合
  const baseline = padding.top + chartHeight;
  let area = `M ${coords[0].x} ${baseline} L ${coords[0].x} ${coords[0].y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const cpx = (prev.x + curr.x) / 2;
    area += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  area += ` L ${coords[coords.length - 1].x} ${baseline} Z`;

  return { line, area };
}

/** 构建某点的 SVG 坐标（tooltip 定位用） */
export function pointCoordAt(
  index: number,
  point: DataPoint,
  count: number,
  maxVal: number,
  chartWidth: number,
  chartHeight: number,
  padding: ChartPadding,
): { x: number; y: number } {
  return pointToCoord(index, point.value, count, maxVal, chartWidth, chartHeight, padding);
}

/**
 * 构建 Y 轴刻度（值 + y 坐标）。
 * @param maxVal 最大值
 * @param count 刻度数量
 */
export function buildYTicks(
  maxVal: number,
  count: number,
  chartHeight: number,
  padding: ChartPadding,
): { value: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const value = Math.round((maxVal / (count - 1)) * i);
    const y = padding.top + chartHeight - (value / maxVal) * chartHeight;
    return { value, y };
  });
}
