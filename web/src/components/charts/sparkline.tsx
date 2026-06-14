/**
 * Sparkline 迷你趋势图（纯 SVG 渲染）。
 *
 * 极小尺寸的折线 + 半透明面积图，常嵌在统计卡片内显示趋势。
 * 贝塞尔曲线平滑，无坐标轴、无 tooltip（与完整 AreaChart 的区别）。
 * 数据不足 2 点时不渲染。
 *
 * 用法：
 *   <Sparkline values={[1, 3, 2, 5, 4]} />
 *   <Sparkline values={seq} color="var(--chart-2)" width={100} height={28} />
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface SparklineProps {
  /** 数值序列（≥2 才渲染） */
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

/**
 * 计算数据点坐标（path / areaPath 共享，避免重复算）。
 * 自动按 min/max 归一化到 [pad, width-pad] × [pad, height-pad]。
 */
function calcPoints(values: number[], width: number, height: number) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const step = w / (values.length - 1);
  return values.map((v, i) => ({
    x: pad + i * step,
    y: pad + h - ((v - min) / range) * h,
  }));
}

/** 将点序列转为贝塞尔曲线 path（每段控制点 x = 端点中点） */
function toCurvePath(points: { x: number; y: number }[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  return d;
}

export function Sparkline({
  values, color = "var(--chart-1)", width = 80, height = 24, className,
}: SparklineProps) {
  /** 共享点坐标（消除 path / areaPath 重复计算） */
  const points = useMemo(
    () => values.length < 2 ? [] : calcPoints(values, width, height),
    [values, width, height],
  );

  /** 线条 path */
  const linePath = useMemo(() => points.length < 2 ? "" : toCurvePath(points), [points]);
  /** 面积 path：从底部起 → 沿曲线 → 回底部闭合 */
  const areaPath = useMemo(() => {
    if (points.length < 2) return "";
    return `M ${points[0].x} ${height} L ${points[0].x} ${points[0].y} ` +
      toCurvePath(points).replace("M ", "").replace(/^[^ ]+ [^ ]+ /, "") +
      ` L ${points[points.length - 1].x} ${height} Z`;
  }, [points, height]);

  if (values.length < 2) return null;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      className={cn("inline-block max-w-full", className)}>
      <path d={areaPath} fill={color} opacity={0.15} className="chart-area-fade" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" className="chart-line-draw" />
    </svg>
  );
}
