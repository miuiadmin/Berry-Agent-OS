/**
 * 分隔线 — 封装 HeroUI Separator。
 *
 * 保持原有 export 接口（orientation, className），
 * 内部委托 HeroUI Separator 组件（基于 react-aria Separator）。
 *
 * HeroUI v3 Separator 接受 orientation（horizontal|vertical）和 variant（default|secondary|tertiary），
 * 不接受原生 HTML div 属性，因此不展开 ...rest。
 */
import { Separator as HeroUISeparator } from "@heroui/react";
import { cn } from "@/lib/utils";

/** 分隔线属性，保持向后兼容的 orientation 接口 */
interface SeparatorProps {
  /** 分隔方向：水平或垂直 */
  orientation?: "horizontal" | "vertical";
  /** 自定义样式类名 */
  className?: string;
}

function Separator({ className, orientation = "horizontal" }: SeparatorProps) {
  return (
    <HeroUISeparator
      orientation={orientation}
      className={cn(className)}
    />
  );
}

export { Separator };
