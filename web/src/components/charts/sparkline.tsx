/**
 * Sparkline — 迷你趋势图（SVG 纯渲染）。
 *
 * 纯 SVG 迷你折线图：贝塞尔曲线 + 半透明面积填充。
 * 无第三方图表库依赖，轻量高可控。
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface SparklineProps {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

/** 计算数据点坐标（path / areaPath 共享） */
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

/** 将点序列转为贝塞尔曲线 path */
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
  /** 面积 path（底部闭合） */
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
