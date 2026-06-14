/**
 * BarChart 水平柱状图组件（纯 div + CSS 渲染）。
 *
 * 形式：每行 = 标签 + 数值 + 进度条。无第三方图表库依赖，轻量高可控。
 * 支持自定义柱体颜色（按条覆盖）、数值格式化函数、stagger 入场动画。
 *
 * 与 AreaChart 的差异：
 *  - AreaChart 是 SVG 折线（连续趋势）；BarChart 是水平进度条（类目对比）
 *  - BarChart 不需要几何计算（柱长 = value/maxVal 直接转百分比），故不依赖 chart-geometry 的 path 模块
 *  - 仅复用 CHART_COLOR_1 默认色；stagger 动画用共享的 staggerClass（ui/_shared）
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
import { staggerClass } from "@/components/ui/_shared";
import { CHART_COLOR_1, safeMaxValue, type DataPoint } from "./chart-geometry";

/**
 * 单条柱子的数据。复用 chart-geometry 的 DataPoint（label + value），
 * 额外允许可选的 per-bar 颜色覆盖 —— 避免重复定义一份仅多一个字段的相似接口。
 */
export interface BarItem extends DataPoint {
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

export function BarChart({
  data,
  className,
  formatValue = (v) => String(v),
}: BarChartProps) {
  const t = useT();

  /** 全局最大值（至少 1 避免除零；空数据走下面的 noData 分支不会用到） */
  const maxVal = useMemo(
    () => safeMaxValue(data.map((d) => d.value)),
    [data],
  );

  /* 空数据 → 显示空态（与其他图表组件一致） */
  if (data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center text-sm text-muted-foreground py-4", className)}>
        {t("common.noData")}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {data.map((item, i) => {
        // 柱长百分比：value/maxVal，clamp 到 [0, 100]
        //   - 上界 100：value > maxVal 时防溢出（maxVal 是数据内最大值，正常不会超，但容错）
        //   - 下界 0：value 为负数（异常输入）时 width 会算出负值，
        //     CSS 对负 width 按 0 处理但语义不明确，显式 clamp 到 0 更清晰
        const widthPct = Math.max(0, Math.min((item.value / maxVal) * 100, 100));
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              {/* 标签截断防溢出：移动端更窄（50%），桌面端放宽（60%）；min-w-0 让 flex 能收缩 */}
              <span className="min-w-0 flex-1 truncate text-muted-foreground max-w-[50%] md:max-w-[60%]">
                {item.label}
              </span>
              {/* 数值列：min-w-0 + truncate 对称处理，防止长格式化串（如 "12,345.67ms"）
                  无限增长挤掉标签或溢出移动端视口；tabular-nums 让数值等宽对齐 */}
              <span className="min-w-0 shrink truncate max-w-[50%] font-medium tabular-nums">
                {formatValue(item.value)}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted">
              {/* 柱体：宽度按百分比 + stagger 类触发 CSS 入场延迟 */}
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  staggerClass(i),
                )}
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: item.color ?? CHART_COLOR_1,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
