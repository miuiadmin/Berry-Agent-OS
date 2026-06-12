/**
 * 滚动区域 — 封装 HeroUI v3 ScrollShadow。
 *
 * 相比原裸 div，ScrollShadow 在内容溢出时自动显示顶部/底部渐隐阴影，
 * 提示可滚动方向，并隐藏可选的滚动条。
 *
 * 实现细节：ScrollShadow 渲染单个 div，forwarded ref 指向滚动容器本身，
 * onScroll / className 等原生 div 属性全部透传，因此可安全替代裸 div。
 *
 * 移动端聊天列表等需要程序化滚动到底部的场景仍可直接用 ref.current.scrollTo()。
 */
"use client";

import * as React from "react";
import { ScrollShadow } from "@heroui/react";
import { cn } from "@/lib/utils";

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 是否隐藏滚动条，默认 false */
  hideScrollBar?: boolean;
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, hideScrollBar, ...props }, ref) => (
    <ScrollShadow
      ref={ref}
      hideScrollBar={hideScrollBar}
      className={cn(className)}
      {...(props as React.ComponentPropsWithRef<typeof ScrollShadow>)}
    >
      {children}
    </ScrollShadow>
  )
);
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
