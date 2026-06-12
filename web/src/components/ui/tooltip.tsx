/**
 * 提示条 — 封装 HeroUI Tooltip。
 *
 * 保持原有 export 接口（content, side, children），
 * 内部委托 HeroUI Tooltip。
 *
 * 映射：
 * - side → placement（top/bottom/left/right 直接对应）
 * - content → showBlur / content prop
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
    <HeroUITooltip
      content={content}
      placement={sideToPlacement[side]}
      delay={150}
      closeDelay={150}
    >
      {children}
    </HeroUITooltip>
  );
}
