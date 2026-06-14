/**
 * AreaChart 面积图组件（纯 SVG 渲染）。
 *
 * 支持主数据线 + 可选第二数据线（如"完成 vs 失败"双线对比）。
 * 鼠标 / 触控 pointer 追踪 tooltip，Y 轴刻度自动计算，X 轴标签均匀采样。
 *
 * 几何计算全部委托给 {@link ./chart-geometry}（path 构建、坐标映射、刻度、采样），
 * 本组件只负责"声明渲染什么 + 交互"，数学逻辑可独立单测。
 *
 * 用法：
 *   <AreaChart data={[{ label: "1月", value: 10 }, ...]} />
 *   <AreaChart data={ok} secondaryData={fail} secondaryColor="var(--destructive)" />
 */

import { useMemo, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  type DataPoint,
  type ChartPadding,
  SVG_WIDTH,
  AREA_CHART_DEFAULT_HEIGHT,
  AREA_CHART_PADDING,
  AREA_CHART_Y_TICK_COUNT,
  AREA_CHART_X_LABEL_MAX,
  CHART_COLOR_1,
  CHART_COLOR_DESTRUCTIVE,
  AREA_STROKE_PRIMARY,
  AREA_STROKE_SECONDARY,
  AREA_FILL_OPACITY,
  safeMaxValue,
  buildSmoothPaths,
  pointCoordAt,
  buildYTicks,
  shouldShowXLabel,
} from "./chart-geometry";

interface AreaChartProps {
  /** 主数据序列 */
  data: DataPoint[];
  /** 主线颜色（CSS 变量或色值，默认 var(--chart-1)） */
  color?: string;
  /** 第二数据序列（可选，如失败数对比） */
  secondaryData?: DataPoint[];
  /** 第二线颜色（默认 var(--destructive)） */
  secondaryColor?: string;
  /** 图表高度（px，默认 160） */
  height?: number;
  /** 容器额外 className */
  className?: string;
}

/** 单条数据线的 path 对（区域填充 + 描边线） */
type LinePaths = ReturnType<typeof buildSmoothPaths>;

/** 单条数据线的渲染参数（主 / 次线复用同一组件） */
interface ChartLineProps {
  paths: LinePaths;
  color: string;
  strokeWidth: number;
  /** 区域填充透明度 */
  opacity: number;
}

/**
 * 单条数据线：区域填充 + 描边线。
 * 抽出来让主 / 次线复用同一渲染逻辑（重构前主线 / 次线 JSX 各写一遍）。
 */
function ChartLine({ paths, color, strokeWidth, opacity }: ChartLineProps) {
  return (
    <>
      <path d={paths.area} fill={color} opacity={opacity} className="chart-area-fade" />
      <path
        d={paths.line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        className="chart-line-draw"
      />
    </>
  );
}

/** Tooltip 状态（null = 隐藏） */
interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: number;
  secondary?: number;
}

export function AreaChart({
  data,
  color = CHART_COLOR_1,
  secondaryData,
  secondaryColor = CHART_COLOR_DESTRUCTIVE,
  height = AREA_CHART_DEFAULT_HEIGHT,
  className,
}: AreaChartProps) {
  const t = useT();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  /**
   * SVG 内边距 + 画布尺寸。
   * 仅依赖 height，独立 memo 避免数据变化时重算（padding 是常数）。
   */
  const layout = useMemo(() => {
    const padding: ChartPadding = AREA_CHART_PADDING;
    return {
      padding,
      svgWidth: SVG_WIDTH,
      chartWidth: SVG_WIDTH - padding.left - padding.right,
      chartHeight: height - padding.top - padding.bottom,
    };
  }, [height]);

  /**
   * 几何派生：Y 轴最大值 / 主次 path / Y 轴刻度。
   * 依赖 data + layout，数据变化时重算；maxVal 合并主次两条线取全局最大，
   * 保证两条线在同一 Y 轴尺度下可比。
   */
  const geo = useMemo(() => {
    const { padding, chartWidth, chartHeight } = layout;
    const allValues = [
      ...data.map((d) => d.value),
      ...(secondaryData?.map((d) => d.value) ?? []),
    ];
    const maxVal = safeMaxValue(allValues);
    return {
      maxVal,
      primary: buildSmoothPaths(data, maxVal, chartWidth, chartHeight, padding),
      secondary: secondaryData
        ? buildSmoothPaths(secondaryData, maxVal, chartWidth, chartHeight, padding)
        : null,
      yTicks: buildYTicks(maxVal, AREA_CHART_Y_TICK_COUNT, chartHeight, padding),
    };
  }, [data, secondaryData, layout]);

  const { padding, svgWidth, chartWidth, chartHeight } = layout;
  const { maxVal, primary, secondary, yTicks } = geo;

  /**
   * 指针移动 → 最近 data point → tooltip。
   * 按指针在 SVG 中的相对位置换算到 viewBox 坐标系（SVG 用 preserveAspectRatio 缩放，
   * rect.width 是实际显示宽度，要做比例换算）。
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (data.length < 2) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
      const step = chartWidth / (data.length - 1);
      const idx = Math.round((x - padding.left) / step);
      // 指针落在绘图区外（左 padding / 右 padding）→ 隐藏 tooltip
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

  /* 数据不足 2 点：无法画线，显示空态 */
  if (data.length < 2) {
    return (
      <div
        className={cn("flex items-center justify-center text-sm text-muted-foreground", className)}
        style={{ height }}
      >
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
        {/* Y 轴刻度线 + 标签（共用 y 坐标，避免网格线和标签错位） */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={svgWidth - padding.right}
              y2={tick.y}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeDasharray="3 3"
            />
            <text
              x={padding.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              opacity={0.4}
            >
              {tick.value}
            </text>
          </g>
        ))}

        {/* X 轴标签（均匀采样，最多 AREA_CHART_X_LABEL_MAX 个） */}
        {data.map((d, i) => {
          if (!shouldShowXLabel(i, data.length, AREA_CHART_X_LABEL_MAX)) return null;
          const x = padding.left + (chartWidth / (data.length - 1)) * i;
          return (
            <text
              key={i}
              x={x}
              y={height - 6}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              opacity={0.4}
            >
              {d.label}
            </text>
          );
        })}

        {/* 第二数据线（先画在底层，避免遮挡主线；更细的描边体现主次） */}
        {secondary && (
          <ChartLine
            paths={secondary}
            color={secondaryColor}
            strokeWidth={AREA_STROKE_SECONDARY}
            opacity={AREA_FILL_OPACITY}
          />
        )}
        {/* 主数据线 */}
        <ChartLine
          paths={primary}
          color={color}
          strokeWidth={AREA_STROKE_PRIMARY}
          opacity={AREA_FILL_OPACITY}
        />

        {/* Tooltip 竖线 + 圆点（指针交互时实时跟随） */}
        {tooltip && (
          <>
            <line
              x1={tooltip.x}
              y1={padding.top}
              x2={tooltip.x}
              y2={padding.top + chartHeight}
              stroke="currentColor"
              strokeOpacity={0.2}
              strokeDasharray="3 3"
            />
            <circle cx={tooltip.x} cy={tooltip.y} r={4} fill={color} />
          </>
        )}
      </svg>

      {/* Tooltip 浮层（HTML 覆盖在 SVG 上方；pointer-events:none 不挡交互） */}
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
            {tooltip.secondary !== undefined && (
              <span style={{ color: secondaryColor }}>{tooltip.secondary}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
