/**
 * 进度条 — 封装 HeroUI v3 ProgressBar compound 组件。
 *
 * 精简 adapter：暴露 value/max/color 的简化 API，内部渲染
 * ProgressBar.Root > Track > Fill 的 compound 结构。
 * HeroUI 自动处理 ARIA progressbar 角色（aria-valuenow/min/max），
 * Fill 宽度由 react-aria 上下文根据 value/maxValue 自动计算。
 */
import { ProgressBar as HeroUIProgressBar } from "@heroui/react";
import type { ProgressBarVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI ProgressBar 支持的颜色变体 */
type ProgressColor = NonNullable<ProgressBarVariants["color"]>;

export interface ProgressProps {
  /** 当前进度值（0 ~ max） */
  value: number;
  /** 最大值，默认 100 */
  max?: number;
  /** 填充色，默认 accent（靛蓝） */
  color?: ProgressColor;
  /** 无障碍标签 */
  "aria-label"?: string;
  /** 透传 className */
  className?: string;
}

/**
 * 确定性进度条。映射到 HeroUI ProgressBar.Root + Track + Fill。
 * Fill 宽度由 HeroUI 根据 value/maxValue 自动计算，带 300ms 宽度过渡动画。
 */
export function Progress({
  value,
  max = 100,
  color = "accent",
  "aria-label": ariaLabel = "progress",
  className,
}: ProgressProps) {
  return (
    <HeroUIProgressBar
      value={value}
      maxValue={max}
      color={color}
      aria-label={ariaLabel}
      className={cn("w-full", className)}
    >
      <HeroUIProgressBar.Track className="h-2 rounded-full overflow-hidden">
        <HeroUIProgressBar.Fill className="rounded-full" />
      </HeroUIProgressBar.Track>
    </HeroUIProgressBar>
  );
}
