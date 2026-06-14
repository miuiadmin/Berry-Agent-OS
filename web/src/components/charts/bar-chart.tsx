/**
 * BarChart 柱状图组件（纯 SVG / div 渲染）。
 *
 * 水平进度条形式：每行 = 标签 + 数值 + 进度条。
 * 支持自定义柱体颜色（按条覆盖）、数值格式化函数、stagger 入场动画。
 * 无第三方图表库依赖，轻量高可控。
 *
 * 用法：
 *   <BarChart data={[
 *     { label: "A", value: 10 },
 *     { label: "B", value: 20, color: "var(--chart-2)" },
 *   ]} />
 *   <BarChart data={...} formatValue={v => `${v}ms`} />
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface BarItem {
  /** 行标签 */
  label: string;
  /** 数值（决定柱长占比） */
  value: number;
  /** 自定义柱色（默认 var(--chart-1)） */
  color?: string;
}

interface BarChartProps {
  /** 数据序列 */
  data: BarItem[];
  /** 容器额外 className */
  className?: string;
  /** 数值格式化（默认 String(v)） */
  formatValue?: (v: number) => string;
}

export function BarChart({ data, className, formatValue = (v) => String(v) }: BarChartProps) {
  const t = useT();
  /** 所有值的最大值（至少 1 避免除零） */
  const maxVal = useMemo(() => Math.max(...data.map((d) => d.value), 1), [data]);

  if (data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center text-sm text-muted-foreground py-4", className)}>
        {t("common.noData")}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {data.map((item, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground truncate max-w-[50%] md:max-w-[60%]">{item.label}</span>
            <span className="font-medium tabular-nums">{formatValue(item.value)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            {/* 柱体宽度按 value/maxVal 比例；stagger 类触发 CSS 入场动画 */}
            <div
              className={`h-full rounded-full transition-all duration-500 stagger-${Math.min(i + 1, 8)}`}
              style={{
                width: `${(item.value / maxVal) * 100}%`,
                backgroundColor: item.color ?? "var(--chart-1)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
