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
 *   <AreaChart data={ok} secondaryData={fail} secondaryColor="var(--chart-2)" />
 */

import { useMemo, useState, useCallback, useRef, memo } from "react";
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
 *
 * 用 React.memo 包裹：AreaChart 在 pointer 移动时高频 setState（tooltip），
 * 导致整个组件树 re-render；ChartLine 的 props（paths / color / strokeWidth /
 * opacity）在数据不变时引用稳定（paths 来自 useMemo 派生），memo 后 props 浅比较
 * 相等即可跳过这条线的重渲染与 diff（path 字符串可能含上百段 C 命令，diff 开销不可忽略）。
 */
const ChartLine = memo(function ChartLine({ paths, color, strokeWidth, opacity }: ChartLineProps) {
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
});

/** Tooltip 状态（null = 隐藏） */
interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: number;
  secondary?: number;
}

/**
 * Tooltip 上下翻转阈值（viewBox 坐标系 y 值）。
 *
 * 当命中点的 y 小于此值时，tooltip 默认的 translate(-50%, -100%)（浮在点上方）
 * 会让 tooltip 顶部超出容器顶部被 overflow-hidden 裁掉，此时改翻转到点下方。
 *
 * 取值 = tooltip 自身高度（约 44px，含 label 行 + 数值行 + padding）+ 顶部安全间距。
 * 与 {@link AREA_CHART_PADDING}.top（20）配合：padding.top 已给顶部留了 20px，
 * 44px 阈值覆盖了"tooltip 高度超出 padding 区"的临界场景。
 */
const TOOLTIP_FLIP_THRESHOLD = 48;

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
  // 上一次命中的数据点索引，用于去抖：指针在同一个点内移动时不重复 setState
  // （SVG 上快速滑动会触发每像素一次 pointermove，60Hz 高刷屏可达成百上千次/秒，
  //  仅在 idx 跨越到新点时才更新 tooltip，避免整个组件树无谓 re-render）
  const lastIdxRef = useRef<number | null>(null);

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
   *
   * 长度对齐：secondaryData 在 buildSmoothPaths 里独立按自身 length 计算 X 步长，
   * 若与 data 长度不一致，次线会被横向压缩/拉伸，与主轴的 X 采样错位。
   * 这里显式截取 secondaryData 前 data.length 个点对齐到主轴长度（防御性 —— 现有
   * 调用方 UsagePage/HomePage 都同源派生、长度天然一致，但组件不应假设这点）。
   */
  const geo = useMemo(() => {
    const { padding, chartWidth, chartHeight } = layout;
    // 次线对齐到主线长度：取前 data.length 个点（多余的丢弃，不足时 buildSmoothPaths
    // 内部 <2 守卫会返回空 path，次线不渲染 —— 不影响主图）
    const alignedSecondary =
      secondaryData && secondaryData.length > 1
        ? secondaryData.slice(0, data.length)
        : undefined;
    const allValues = [
      ...data.map((d) => d.value),
      ...(alignedSecondary?.map((d) => d.value) ?? []),
    ];
    const maxVal = safeMaxValue(allValues);
    return {
      maxVal,
      primary: buildSmoothPaths(data, maxVal, chartWidth, chartHeight, padding),
      secondary: alignedSecondary
        ? buildSmoothPaths(alignedSecondary, maxVal, chartWidth, chartHeight, padding)
        : null,
      yTicks: buildYTicks(maxVal, AREA_CHART_Y_TICK_COUNT, chartHeight, padding),
    };
  }, [data, secondaryData, layout]);

  const { padding, svgWidth, chartWidth, chartHeight } = layout;
  const { maxVal, primary, secondary, yTicks } = geo;

  /**
   * 指针移动 → 最近 data point → tooltip。
   * 按指针在 SVG 中的相对位置换算到 viewBox 坐标系（SVG 用 preserveAspectRatio="none"
   * 把 viewBox 拉伸到容器尺寸，rect.width 是实际显示宽度，需做比例换算回 viewBox 坐标）。
   *
   * 去抖 + 边界处理：
   *  1. (x - padding.left) 落到绘图区外（左/右 padding 区）→ 隐藏 tooltip，
   *     不让圆点吸附到首/末点（Math.round 会让靠近边缘的指针算出 idx=0/last）。
   *  2. idx 与上次相同（指针还在同一个点的范围内）→ 跳过 setTooltip，避免高频 re-render。
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (data.length < 2) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
      // 相对绘图区左边界的偏移（绘图区 = [padding.left, padding.left + chartWidth]）
      const dx = x - padding.left;
      // 落在左/右 padding 区 → 直接隐藏并重置 lastIdx（指针已离开数据区）
      if (dx < 0 || dx > chartWidth) {
        if (lastIdxRef.current !== null) {
          lastIdxRef.current = null;
          setTooltip(null);
        }
        return;
      }
      const step = chartWidth / (data.length - 1);
      const idx = Math.round(dx / step);
      // idx 因浮点误差可能轻微越界，clamp 到合法范围（与上面的 dx 检查互补）
      const clampedIdx = Math.max(0, Math.min(idx, data.length - 1));
      // 同一点内的连续移动不重复 setState（高频 pointermove 去抖核心）
      if (lastIdxRef.current === clampedIdx) return;
      lastIdxRef.current = clampedIdx;
      const { x: px, y: py } = pointCoordAt(
        clampedIdx, data[clampedIdx], data.length, maxVal, chartWidth, chartHeight, padding,
      );
      setTooltip({
        x: px, y: py, label: data[clampedIdx].label, value: data[clampedIdx].value,
        secondary: secondaryData?.[clampedIdx]?.value,
      });
    },
    [data, secondaryData, chartWidth, chartHeight, maxVal, padding, svgWidth],
  );

  // 指针离开 SVG：隐藏 tooltip 并清掉 lastIdx（下次进入时强制刷新首个命中点）
  const handlePointerLeave = useCallback(() => {
    lastIdxRef.current = null;
    setTooltip(null);
  }, []);

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
      {/* SVG：viewBox="0 0 svgWidth height" + preserveAspectRatio="none" 让 viewBox 拉伸填满容器
          （width:100% × style.height）。
          为何不用旧 "xMidYMid meet"：style.height 钉死为 viewBox 高度时，meet 选 scale=
          min(containerW/400, 160/160)=1，SVG 只渲染 400px 居中，两侧留 ~33% 空白（letterbox）；
          且 pointerMove 的 x=(clientX/rect.width)*svgWidth 把空白区误判成 viewBox 坐标，
          tooltip 的 left% 落在空白处而它索引的数据点实际更靠右 —— tooltip 偏移 bug。
          改 none 后 viewBox 与容器 1:1 线性映射，pointerMove / tooltip.left / tooltip.top
          三处换算同时正确（y 方向因 style.height===viewBox 高度，1 单位=1px 不变）。 */}
      <svg
        viewBox={`0 0 ${svgWidth} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
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

      {/* Tooltip 浮层（HTML 覆盖在 SVG 上方；pointer-events:none 不挡交互）。
          位置策略：默认在指针点上方（translate -100%）；当指针点贴近顶部时
          （tooltip 会被父级 overflow-hidden 裁掉），翻转到点下方避免溢出。 */}
      {tooltip && (() => {
        // 命中点贴近顶部时 tooltip 会被父级 overflow-hidden 裁掉 → 翻转到点下方
        const flipBelow = tooltip.y < TOOLTIP_FLIP_THRESHOLD;
        return (
          <div
            className="absolute pointer-events-none z-10 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md animate-fade-in"
            style={{
              left: `${(tooltip.x / svgWidth) * 100}%`,
              top: `${flipBelow ? tooltip.y + 12 : tooltip.y - 10}px`,
              transform: flipBelow
                ? "translate(-50%, 0)"
                : "translate(-50%, -100%)",
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
        );
      })()}
    </div>
  );
}
