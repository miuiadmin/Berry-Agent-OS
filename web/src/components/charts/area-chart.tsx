/**
 * AreaChart — 面积图组件（SVG）。
 *
 * 支持主数据线 + 可选的第二数据线（如完成 vs 失败），
 * 鼠标/触控 pointer 追踪 tooltip，Y 轴刻度自动计算。
 *
 * 几何计算委托给 chart-geometry.ts 纯函数模块，本组件只负责 SVG 渲染和交互。
 */

import { useMemo, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  type DataPoint,
  type ChartPadding,
  SVG_WIDTH,
  buildSmoothPath,
  pointCoordAt,
  buildYTicks,
} from "./chart-geometry";

interface AreaChartProps {
  /** 主数据序列 */
  data: DataPoint[];
  /** 主线颜色（CSS 变量或色值） */
  color?: string;
  /** 第二数据序列（可选，如失败数） */
  secondaryData?: DataPoint[];
  /** 第二线颜色 */
  secondaryColor?: string;
  /** 图表高度（px） */
  height?: number;
  /** 额外样式类 */
  className?: string;
}

/** 单条数据线的 path 对（区域填充 + 描边线） */
type LinePaths = ReturnType<typeof buildSmoothPath>;

/** 单条数据线渲染：区域填充 + 描边线（主/次数据复用） */
function ChartLine({ paths, color, strokeWidth, opacity }: {
  paths: LinePaths;
  color: string;
  strokeWidth: number;
  /** 区域填充透明度 */
  opacity: number;
}) {
  return (
    <>
      <path d={paths.area} fill={color} opacity={opacity} className="chart-area-fade" />
      <path d={paths.line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" className="chart-line-draw" />
    </>
  );
}

export function AreaChart({
  data,
  color = "var(--chart-1)",
  secondaryData,
  secondaryColor = "var(--destructive)",
  height = 160,
  className,
}: AreaChartProps) {
  const t = useT();
  /** 当前 tooltip 状态（null = 隐藏） */
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    label: string;
    value: number;
    secondary?: number;
  } | null>(null);

  /** SVG 内边距 + 画布尺寸（仅依赖 height） */
  const layout = useMemo(() => {
    const padding: ChartPadding = { top: 20, right: 12, bottom: 28, left: 36 };
    return {
      padding,
      svgWidth: SVG_WIDTH,
      chartWidth: SVG_WIDTH - padding.left - padding.right,
      chartHeight: height - padding.top - padding.bottom,
    };
  }, [height]);

  /** 几何派生：最大值 / 主次 path / Y 轴刻度（依赖 data + layout） */
  const geo = useMemo(() => {
    const { padding, chartWidth, chartHeight } = layout;
    /** 合并所有数据值用于计算 Y 轴最大值（至少 1 避免除零） */
    const allValues = [...data.map((d) => d.value), ...(secondaryData?.map((d) => d.value) ?? [])];
    const maxVal = Math.max(...allValues, 1);
    return {
      maxVal,
      primary: buildSmoothPath(data, maxVal, chartWidth, chartHeight, padding),
      secondary: secondaryData ? buildSmoothPath(secondaryData, maxVal, chartWidth, chartHeight, padding) : null,
      yTicks: buildYTicks(maxVal, 4, chartHeight, padding),
    };
  }, [data, secondaryData, layout]);

  const { padding, svgWidth, chartWidth, chartHeight } = layout;
  const { maxVal, primary, secondary, yTicks } = geo;

  /**
   * 指针移动时，计算最近 data point 并更新 tooltip。
   * 按指针在 SVG 中的相对位置换算到 viewBox 坐标系。
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (data.length < 2) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
      const step = chartWidth / (data.length - 1);
      const idx = Math.round((x - padding.left) / step);
      if (idx < 0 || idx >= data.length) {
        setTooltip(null);
        return;
      }
      const { x: px, y: py } = pointCoordAt(
        idx, data[idx], data.length, maxVal, chartWidth, chartHeight, padding,
      );
      setTooltip({
        x: px, y: py, label: data[idx].label, value: data[idx].value,
        secondary: secondaryData?.[idx]?.value,
      });
    },
    [data, secondaryData, chartWidth, chartHeight, maxVal, padding, svgWidth],
  );

  /* 数据不足 2 点时无法画线 */
  if (data.length < 2) {
    return (
      <div className={cn("flex items-center justify-center text-sm text-muted-foreground", className)} style={{ height }}>
        {t("common.noData")}
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      <svg
        viewBox={`0 0 ${svgWidth} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
        style={{ height }}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setTooltip(null)}
      >
        {/* Y 轴刻度线 + 标签 */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line x1={padding.left} y1={tick.y} x2={svgWidth - padding.right} y2={tick.y}
              stroke="currentColor" strokeOpacity={0.08} strokeDasharray="3 3" />
            <text x={padding.left - 6} y={tick.y + 3} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.4}>
              {tick.value}
            </text>
          </g>
        ))}

        {/* X 轴标签（最多 7 个，均匀采样） */}
        {data.map((d, i) => {
          if (i % Math.ceil(data.length / 7) !== 0 && i !== data.length - 1) return null;
          const x = padding.left + (chartWidth / (data.length - 1)) * i;
          return (
            <text key={i} x={x} y={height - 6} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.4}>
              {d.label}
            </text>
          );
        })}

        {/* 第二数据线（先画在底层） */}
        {secondary && <ChartLine paths={secondary} color={secondaryColor} strokeWidth={1.5} opacity={0.1} />}
        {/* 主数据线 */}
        <ChartLine paths={primary} color={color} strokeWidth={2} opacity={0.15} />

        {/* Tooltip 竖线 + 圆点 */}
        {tooltip && (
          <>
            <line x1={tooltip.x} y1={padding.top} x2={tooltip.x} y2={padding.top + chartHeight}
              stroke="currentColor" strokeOpacity={0.2} strokeDasharray="3 3" />
            <circle cx={tooltip.x} cy={tooltip.y} r={4} fill={color} />
          </>
        )}
      </svg>

      {/* Tooltip 浮层（HTML 覆盖在 SVG 上方） */}
      {tooltip && (
        <div
          className="absolute pointer-events-none z-10 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md animate-fade-in"
          style={{
            left: `${(tooltip.x / svgWidth) * 100}%`,
            top: `${tooltip.y - 10}px`,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="font-medium">{tooltip.label}</div>
          <div className="flex items-center gap-2">
            <span style={{ color }}>{tooltip.value}</span>
            {tooltip.secondary !== undefined && <span style={{ color: secondaryColor }}>{tooltip.secondary}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
