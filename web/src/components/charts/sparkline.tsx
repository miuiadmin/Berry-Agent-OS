
import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface SparklineProps {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  color = "var(--chart-1)",
  width = 80,
  height = 24,
  className,
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const padding = 2;
    const w = width - padding * 2;
    const h = height - padding * 2;
    const step = w / (values.length - 1);

    const points = values.map((v, i) => ({
      x: padding + i * step,
      y: padding + h - ((v - min) / range) * h,
    }));

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
    }
    return d;
  }, [values, width, height]);

  const areaPath = useMemo(() => {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const padding = 2;
    const w = width - padding * 2;
    const h = height - padding * 2;
    const step = w / (values.length - 1);

    const points = values.map((v, i) => ({
      x: padding + i * step,
      y: padding + h - ((v - min) / range) * h,
    }));

    let d = `M ${points[0].x} ${height}`;
    d += ` L ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
    }
    d += ` L ${points[points.length - 1].x} ${height} Z`;
    return d;
  }, [values, width, height]);

  if (values.length < 2) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("inline-block max-w-full", className)}
    >
      <path d={areaPath} fill={color} opacity={0.15} className="chart-area-fade" />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" className="chart-line-draw" />
    </svg>
  );
}
