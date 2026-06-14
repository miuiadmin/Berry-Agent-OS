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
 * ScrollArea 暴露的 props。
 *
 * ⚠️ Root vs Viewport 的职责差异（曾导致流式输出不自动滚到底）：
 *   - Root：position:relative 的布局容器，**没有 overflow，不滚动**。className / style 等普通 div
 *     属性继续走 ...props 喂给它。
 *   - Viewport：唯一 overflow:scroll 的真实滚动元素。要程序化滚动（scrollTop = scrollHeight）
 *     或监听滚动位置，ref / onScroll 必须绑到 Viewport——绑到 Root 上 scrollTop/scrollHeight 恒为
 *     0、scroll 事件不冒泡到 Root，自动跟随、滚到底按钮、isNearBottom 判定全部失效。
 *   为消除这个踩坑面，wrapper 显式区分两类 prop：滚动相关走 viewportRef / onViewportScroll
 *   （转发给 Viewport），调用方一看签名就知道该传哪个。
 *   Base UI 的 mergeProps 会把消费者 onScroll 与内部 computeThumbPosition 的 onScroll 合并
 *   （两者都触发），自定义滚动条同步不受影响。
 */
interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  /** 指向内部 Viewport（唯一 overflow:scroll 元素）的 DOM 引用——程序化滚动 / 滚动监听绑这里 */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Viewport 滚动回调（监听滚动位置用此 prop，而非 onScroll——后者会落到不滚动的 Root 上失效） */
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}

/**
 * 滚动容器根。默认 relative，宽度高度由调用方 className 控制。
 */
function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        ref={viewportRef}
        onScroll={onViewportScroll}
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow]",
          FOCUS_RING,
          // 覆盖 FOCUS_RING 的 outline-none：滚动容器键盘聚焦时显示 1px 细描边，
          // 提示可滚动区域边界（FOCUS_RING 的 ring-3 在长滚动容器里视觉过重）。
          // outline-1 在 FOCUS_RING 之后声明，胜出 cascade，与 ring-3 共同呈现。
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
  // 注意：Base UI Scrollbar 暴露 data-orientation="vertical"（非裸 data-vertical），
  // 用 data-[orientation=vertical]: 才能命中，否则下面所有尺寸类静默失效。
  vertical:
    "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent",
  // 横向：撑满宽度、2.5 高、顶部透明分隔线，并切到 flex-col
  horizontal:
    "data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-t-transparent",
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
