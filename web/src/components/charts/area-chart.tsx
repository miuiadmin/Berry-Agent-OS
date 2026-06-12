
import { useMemo, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface DataPoint {
  label: string;
  value: number;
}

interface AreaChartProps {
  data: DataPoint[];
  color?: string;
  secondaryData?: DataPoint[];
  secondaryColor?: string;
  height?: number;
  className?: string;
}

export function AreaChart({
  data,
  color = "var(--chart-1)",
  secondaryData,
  secondaryColor = "var(--danger)",
  height = 160,
  className,
}: AreaChartProps) {
  const t = useT();
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number; secondary?: number } | null>(null);

  const allValues = useMemo(() => {
    const primary = data.map((d) => d.value);
    const secondary = secondaryData?.map((d) => d.value) ?? [];
    return [...primary, ...secondary];
  }, [data, secondaryData]);

  const maxVal = useMemo(() => Math.max(...allValues, 1), [allValues]);

  const padding = { top: 20, right: 12, bottom: 28, left: 36 };
  const svgWidth = 400;
  const chartWidth = svgWidth - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const buildPath = useCallback(
    (points: DataPoint[]) => {
      if (points.length < 2) return { line: "", area: "" };
      const step = chartWidth / (points.length - 1);
      const coords = points.map((p, i) => ({
        x: padding.left + i * step,
        y: padding.top + chartHeight - (p.value / maxVal) * chartHeight,
      }));

      let line = `M ${coords[0].x} ${coords[0].y}`;
      for (let i = 1; i < coords.length; i++) {
        const prev = coords[i - 1];
        const curr = coords[i];
        const cpx = (prev.x + curr.x) / 2;
        line += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
      }

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
    },
    [chartWidth, chartHeight, maxVal, padding.left, padding.top],
  );

  const primary = useMemo(() => buildPath(data), [buildPath, data]);
  const secondary = useMemo(
    () => (secondaryData ? buildPath(secondaryData) : null),
    [buildPath, secondaryData],
  );

  const yTicks = useMemo(() => {
    const count = 4;
    return Array.from({ length: count }, (_, i) => {
      const value = Math.round((maxVal / (count - 1)) * i);
      const y = padding.top + chartHeight - (value / maxVal) * chartHeight;
      return { value, y };
    });
  }, [maxVal, chartHeight, padding.top]);

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
      const px = padding.left + idx * step;
      const py = padding.top + chartHeight - (data[idx].value / maxVal) * chartHeight;
      setTooltip({
        x: px,
        y: py,
        label: data[idx].label,
        value: data[idx].value,
        secondary: secondaryData?.[idx]?.value,
      });
    },
    [data, secondaryData, chartWidth, chartHeight, maxVal, padding.left, padding.top, svgWidth],
  );

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

        {data.map((d, i) => {
          if (i % Math.ceil(data.length / 7) !== 0 && i !== data.length - 1) return null;
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

        {secondary && (
          <>
            <path d={secondary.area} fill={secondaryColor} opacity={0.1} className="chart-area-fade" />
            <path d={secondary.line} fill="none" stroke={secondaryColor} strokeWidth={1.5} strokeLinecap="round" className="chart-line-draw" />
          </>
        )}

        <path d={primary.area} fill={color} opacity={0.15} className="chart-area-fade" />
        <path d={primary.line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" className="chart-line-draw" />

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
