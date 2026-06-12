/**
 * 提示条 — 封装 HeroUI v3 Tooltip（react-aria compound）。
 *
 * 保持原有 export 接口（content, side, children），
 * 内部委托 HeroUI Tooltip compound：Tooltip.Root（trigger 包裹器）+ Tooltip.Content。
 *
 * react-aria 的 TooltipTrigger 要求子元素是可接收 press/focus 的元素，
 * 因此用 TooltipTrigger（render a div wrapper）包裹 children，避免
 * "PressResponder was rendered without a pressable child" 警告。
 *
 * side → placement（top/bottom/left/right 直接对应）。
 */
import { Tooltip as HeroUITooltip } from "@heroui/react";
import type { ReactNode } from "react";

/** side → HeroUI placement 映射 */
const sideToPlacement: Record<string, "top" | "bottom" | "left" | "right"> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
};

interface TooltipProps {
  content: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

export function Tooltip({ content, side = "top", children }: TooltipProps) {
  return (
    <HeroUITooltip placement={sideToPlacement[side]} delay={150} closeDelay={150}>
      {/* TooltipTrigger 充当可 press/focus 的触发器，包裹 children */}
      <HeroUITooltip.Trigger>{children}</HeroUITooltip.Trigger>
      <HeroUITooltip.Content>{content}</HeroUITooltip.Content>
    </HeroUITooltip>
  );
}
