/**
 * 提示条 — 封装 HeroUI v3 Tooltip（react-aria compound）。
 *
 * 保持原有 export 接口（content, side, children），
 * 内部委托 HeroUI Tooltip compound：Tooltip.Root（trigger 包裹器）+ Tooltip.Content。
 *
 * 架构说明：
 * - Tooltip.Root = react-aria TooltipTrigger，接受 delay/closeDelay/isDisabled
 * - Tooltip.Trigger = 可 press/focus 的触发器 wrapper（避免 "PressResponder was rendered
 *   without a pressable child" 警告）
 * - Tooltip.Content = react-aria Tooltip，接受 placement/showArrow/offset/className
 *
 * side → placement（top/bottom/left/right 直接对应）。
 */
import { Tooltip as HeroUITooltip } from "@heroui/react";
import type { ReactNode } from "react";

/** side → HeroUI placement 映射（值相同，显式映射便于后续扩展） */
const sideToPlacement: Record<string, "top" | "bottom" | "left" | "right"> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
};

interface TooltipProps {
  /** 提示条文本内容 */
  content: string;
  /** 提示条出现的方位 */
  side?: "top" | "bottom" | "left" | "right";
  /** 触发元素 */
  children: ReactNode;
}

export function Tooltip({ content, side = "top", children }: TooltipProps) {
  return (
    /* delay/closeDelay 作用于 Root（即 react-aria TooltipTrigger） */
    <HeroUITooltip delay={150} closeDelay={150}>
      {/* TooltipTrigger 充当可 press/focus 的触发器，包裹 children */}
      <HeroUITooltip.Trigger>{children}</HeroUITooltip.Trigger>
      {/* placement 作用于 Content（即 react-aria Tooltip），不是 Root */}
      <HeroUITooltip.Content placement={sideToPlacement[side]}>
        {content}
      </HeroUITooltip.Content>
    </HeroUITooltip>
  );
}
