/**
 * 计数动画数值展示 — 从 0 递增到目标值的动画效果。
 *
 * 从 HomePage 和 UsagePage 提取的共享组件。
 */
import { useCountUp } from "@/hooks/use-count-up";

interface AnimatedStatProps {
  /** 目标数值 */
  value: number;
  /** 自定义格式化函数（如 formatTokens） */
  format?: (n: number) => string;
}

/** 计数动画数值展示。挂载时从 0 递增到 value */
export function AnimatedStat({ value, format }: AnimatedStatProps) {
  const animated = useCountUp(value);
  const display = format ? format(animated) : String(animated);
  return <span className="tabular-nums">{display}</span>;
}
