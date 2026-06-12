/**
 * 骨架屏 — 封装 HeroUI Skeleton。
 *
 * 保持原有 export 接口（className 传尺寸），内部委托 HeroUI Skeleton。
 * HeroUI v3 Skeleton 直接渲染为带动画占位的 div，通过 className 控制尺寸。
 */
import { Skeleton as HeroUISkeleton } from "@heroui/react";
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <HeroUISkeleton className={cn("rounded-md", className)} />;
}
