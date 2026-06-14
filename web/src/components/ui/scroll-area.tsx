/**
 * ScrollArea 滚动区域组件（基于 Base UI 原语）。
 *
 * 自定义滚动条样式的滚动容器：保留原生滚动行为，仅美化滚动条外观。
 * 适用于长列表 / 聊天窗口 / 侧栏等需要细滚动条的场景。
 *
 * 用法：
 *   <ScrollArea className="h-72">
 *     <长内容 />
 *   </ScrollArea>
 *
 * 自动添加纵向 + 横向 ScrollBar；Viewport 100% 撑满 Root。
 *
 * 结构性重构：把 ScrollBar 在 horizontal / vertical 两种朝向下的差异类
 * （flex 方向、边框、宽高）拆成 Record，可读性优于单条 data-horizontal:/data-vertical:
 * 并列的长字符串。
 */

"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"
import { FOCUS_RING } from "@/components/ui/_shared"

/**
 * 滚动容器根。
 * 默认 relative，宽度高度由调用方 className 控制。
 */
function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow]",
          FOCUS_RING,
          "focus-visible:outline-1"
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

/** ScrollBar 在两种朝向下的差异（公共部分在主 className） */
const ORIENTATION_VARIANT: Record<"vertical" | "horizontal", string> = {
  // 纵向：撑满高度、2.5 宽、左侧透明分隔线
  vertical: "data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
  // 横向：撑满宽度、2.5 高、顶部透明分隔线，并切到 flex-col
  horizontal: "data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent",
}

/**
 * 自定义滚动条（横向 / 纵向）。
 * @param orientation vertical（默认）/ horizontal
 */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        ORIENTATION_VARIANT[orientation],
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
