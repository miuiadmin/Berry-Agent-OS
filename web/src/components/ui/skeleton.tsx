/**
 * 骨架屏 — 封装 HeroUI Skeleton。
 *
 * 保持原有 export 接口（className 传尺寸），内部委托 HeroUI Skeleton。
 */
import { Skeleton as HeroUISkeleton } from "@heroui/react";
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <HeroUISkeleton className={cn("rounded-md", className)} />;
}
