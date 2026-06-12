/**
 * 抽屉 — 封装 HeroUI v3 Drawer compound（基于 react-aria-components Dialog）。
 *
 * HeroUI Drawer compound 结构：
 *   Root > Backdrop + Container > Dialog > [Header + Body + Footer + CloseTrigger]
 *
 * 提供简化 API：
 *   <Drawer open={open} onOpenChange={setOpen} placement="left">
 *     {children}
 *   </Drawer>
 *
 * 自动处理：遮罩层点击关闭、ESC 关闭、聚焦陷阱、滑入/滑出动画。
 */
import * as React from "react";
import {
  Drawer as HeroUIDrawer,
} from "@heroui/react";
import { cn } from "@/lib/utils";

export interface DrawerProps {
  /** 受控开关 */
  open: boolean;
  /** 开关回调 */
  onOpenChange: (open: boolean) => void;
  /** 抽屉方向，默认 left（侧边栏） */
  placement?: "left" | "right" | "top" | "bottom";
  /** 子内容 */
  children: React.ReactNode;
  /** 透传 className */
  className?: string;
}

/**
 * 抽屉组件。
 *
 * 自动提供遮罩层、滑入/滑出动画、ESC/点击遮罩关闭、聚焦陷阱。
 * 适合移动端侧边栏 overlay、筛选面板等场景。
 */
export function Drawer({ open, onOpenChange, placement = "left", children, className }: DrawerProps) {
  return (
    <HeroUIDrawer isOpen={open} onOpenChange={onOpenChange}>
      <HeroUIDrawer.Backdrop
        className="fixed inset-0 z-40 bg-black/50 data-[entering]:animate-overlay-in data-[exiting]:animate-overlay-out"
      />
      <HeroUIDrawer.Content
        className={cn(
          "fixed z-50 bg-background shadow-xl",
          /* 左侧滑入 */
          placement === "left" && "inset-y-0 left-0 h-full w-72 data-[entering]:animate-sidebar-in data-[exiting]:animate-sidebar-out",
          /* 右侧滑入 */
          placement === "right" && "inset-y-0 right-0 h-full w-72 data-[entering]:animate-sidebar-in data-[exiting]:animate-sidebar-out",
          className
        )}
      >
        {children}
      </HeroUIDrawer.Content>
    </HeroUIDrawer>
  );
}
