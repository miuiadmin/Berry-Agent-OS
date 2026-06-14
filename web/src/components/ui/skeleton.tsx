/**
 * Skeleton 骨架屏组件。
 *
 * 加载态占位：animate-pulse 灰色块，尺寸由调用方 className 控制。
 * 配合 CardListSkeleton / StatCard.loading 等封装使用，也可独立用。
 *
 * 用法：
 *   <Skeleton className="h-4 w-1/3" />
 *   <Skeleton className="size-10 rounded-full" />
 */

import { cn } from "@/lib/utils"

/** 占位块：脉冲动画 + muted 背景 + 圆角（细节由 className 控制） */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
