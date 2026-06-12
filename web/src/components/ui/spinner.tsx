/**
 * 加载旋转器 — 封装 HeroUI v3 Spinner。
 *
 * 精简 adapter：暴露 size/color 的简化 API。
 * HeroUI Spinner 自动处理 SVG 旋转动画和无障碍属性。
 */
import { Spinner as HeroUISpinner } from "@heroui/react";
import type { SpinnerVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI Spinner 支持的尺寸 */
type SpinnerSize = NonNullable<SpinnerVariants["size"]>;

export interface SpinnerProps {
  /** 尺寸，默认 sm */
  size?: SpinnerSize;
  /** 透传 className */
  className?: string;
}

/**
 * 加载旋转器。映射到 HeroUI Spinner.Root。
 * 用于替代手写的 border-spin 或 Lucide Loader2 + animate-spin。
 */
export function Spinner({ size = "sm", className }: SpinnerProps) {
  return <HeroUISpinner size={size} className={cn(className)} />;
}
