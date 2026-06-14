/**
 * Sparkline 迷你趋势图（纯 SVG 渲染）。
 *
 * 极小尺寸的折线 + 半透明面积图，常嵌在统计卡片角落显示趋势。
 * 贝塞尔曲线平滑，无坐标轴 / 无 tooltip（与完整 AreaChart 的差异）。
 *
 * 与 AreaChart 的关键区别（重构前两份代码 80% 重复，现已统一到 chart-geometry）：
 *  - 双轴按实际 min/max 自适应归一化（{@link normalizePoints}），让小范围波动也明显
 *    ——AreaChart 则是 Y 轴固定从 0 起
 *  - 无坐标轴 / 无 tooltip / 无交互，纯展示
 *  - 数据不足 2 点时不渲染（返回 null，不像 AreaChart 显示 noData 文案——卡片角落没空间放）
 *
 * 用法：
 *   <Sparkline values={[1, 3, 2, 5, 4]} />
 *   <Sparkline values={seq} color="var(--chart-2)" width={100} height={28} />
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  SPARKLINE_DEFAULT_WIDTH,
  SPARKLINE_DEFAULT_HEIGHT,
  CHART_COLOR_1,
  SPARKLINE_STROKE,
  SPARKLINE_FILL_OPACITY,
  normalizePoints,
  smoothLinePath,
  smoothAreaPath,
} from "./chart-geometry";

interface SparklineProps {
  /** 数值序列（≥ 2 才渲染，否则返回 null） */
  values: number[];
  /** 线条 + 面积颜色（默认 var(--chart-1)） */
  color?: string;
  /** SVG 宽度（默认 80） */
  width?: number;
  /** SVG 高度（默认 24） */
  height?: number;
  /** 容器额外 className */
  className?: string;
}

export function Sparkline({
  values,
  color = CHART_COLOR_1,
  width = SPARKLINE_DEFAULT_WIDTH,
  height = SPARKLINE_DEFAULT_HEIGHT,
  className,
}: SparklineProps) {
  /**
   * 点坐标：normalizePoints 内部做 min/max 归一化 + 留白。
   * useMemo 避免每次 render 重算（虽然计算量小，但 path 派生依赖它）。
   */
  const points = useMemo(
    () => (values.length < 2 ? [] : normalizePoints(values, width, height)),
    [values, width, height],
  );

  /** 线条 path（空数组时 smoothLinePath 返回空串，渲染时 SVG path 不绘制） */
  const linePath = useMemo(() => smoothLinePath(points), [points]);
  /**
   * 面积 path：基线 = SVG 底部（y = height）。
   * smoothAreaPath 内部复用 smoothLinePath 的曲线段，首尾各加一条到基线的 L。
   */
  const areaPath = useMemo(() => smoothAreaPath(points, height), [points, height]);

  /* 数据不足 2 点：无法画线，不渲染（卡片角落无空间放 noData 文案） */
  if (values.length < 2) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("inline-block max-w-full", className)}
    >
      {/* 先画面积（在底层），再画线条（在顶层），与 AreaChart 的渲染顺序一致 */}
      <path
        d={areaPath}
        fill={color}
        opacity={SPARKLINE_FILL_OPACITY}
        className="chart-area-fade"
      />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={SPARKLINE_STROKE}
        strokeLinecap="round"
        className="chart-line-draw"
      />
    </svg>
  );
}
