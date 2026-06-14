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
   * 数据是否足够（≥ 2 点才能画出折线）。
   * 关键：不在 hooks 之前 early return，而是用一个布尔量在 hooks 内部守卫计算。
   * 否则当父组件传入的 values 在不同 render 间跨越 2 点边界（1↔3 点）时，
   * React 会因 hook 数量变化抛出 "Rendered more hooks than during the previous render."
   * 导致整棵子树白屏。保持 hook 调用顺序恒定是 React 的硬约束，优先于性能微优化。
   */
  const hasEnoughData = values.length >= 2;

  /**
   * 点坐标：normalizePoints 内部做 min/max 归一化 + 留白。
   * 数据不足时返回空数组（normalizePoints 对 <2 点返回 []），避免白跑后还要兜底；
   * 同时让 useMemo 依赖与返回值稳定，下游 path 派生自然得到空串。
   */
  const points = useMemo(
    () => (hasEnoughData ? normalizePoints(values, width, height) : []),
    [hasEnoughData, values, width, height],
  );

  /**
   * 线条 + 面积 path 一次派生（areaPath 基线 = SVG 底部 y = height）。
   * 合并到单个 useMemo：两者共享同一份 points 输入，拆开会让两个 memo 各自
   * 缓存一份 points 引用判断，无收益。空数组时均返回空串，SVG path 不绘制。
   */
  const { linePath, areaPath } = useMemo(
    () => ({
      linePath: smoothLinePath(points),
      areaPath: smoothAreaPath(points, height),
    }),
    [points, height],
  );

  // 数据不足 2 点：无法画线，不渲染（卡片角落无空间放 noData 文案）。
  // 放在所有 hooks 之后，保证 hook 调用顺序恒定，杜绝 Rules of Hooks 崩溃。
  if (!hasEnoughData) return null;

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
