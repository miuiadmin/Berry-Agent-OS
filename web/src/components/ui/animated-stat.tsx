/**
 * AnimatedStat — 带计数动画的数值展示组件。
 *
 * 挂载时从 0 动画递增到目标值，常用于 Dashboard 统计卡片。
 * 支持自定义格式化函数（如 formatTokens）。
 */

import { useCountUp } from "@/hooks/use-count-up";

interface AnimatedStatProps {
  /** 目标数值（从 0 动画递增到此值） */
  value: number;
  /** 可选的格式化函数，用于转换动画过程中的数值 */
  format?: (n: number) => string;
}

/** 带计数动画的数值展示 — 挂载时从 0 递增到 value */
export function AnimatedStat({ value, format }: AnimatedStatProps) {
  const animated = useCountUp(value);
  const display = format ? format(animated) : String(animated);
  return <span className="tabular-nums">{display}</span>;
}
