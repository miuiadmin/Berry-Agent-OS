/**
 * 通用 Dialog 组件 — 封装 HeroUI Modal（react-aria compound 模式）。
 *
 * 保持原有 export 接口不变：
 * <Dialog open onOpenChange>
 *   <DialogContent onClose className>
 *     <DialogHeader><DialogTitle/><DialogDescription/></DialogHeader>
 *     <DialogFooter/>
 *   </DialogContent>
 * </Dialog>
 *
 * 桥接说明：
 * - 现有接口是受控的 `open`/`onOpenChange`，HeroUI Modal 通过 `state`（UseOverlayStateReturn）驱动。
 * - 内部用 useOverlayState({ isOpen: open, onOpenChange }) 把受控状态转成 state 对象传给 Modal。
 * - ESC 关闭、遮罩点击关闭、焦点陷阱、焦点恢复、body 滚动锁定、开关动画全部由 react-aria Modal 内置提供，
 *   不再需要手写的 FOCUSABLE_SELECTOR / Tab 循环 / animation 状态机。
 *
 * 结构映射：
 * - Dialog           → Modal.Root + Modal.Backdrop + Modal.Container（外壳）
 * - DialogContent    → Modal.Dialog（视觉容器，含可选关闭按钮）
 * - DialogHeader     → 标题区容器 div
 * - DialogTitle      → 标题文字 h2
 * - DialogDescription→ 描述文字 p
 * - DialogFooter     → 底部操作区 div
 */
"use client";

import { type ReactNode } from "react";
import { X } from "lucide-react";
import { Modal, useOverlayState } from "@heroui/react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface DialogProps {
  /** 受控开关状态 */
  open: boolean;
  /** 开关状态变化回调 */
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Dialog 外壳。
 *
 * 用 useOverlayState 把 `open/onOpenChange` 转成 HeroUI 的 state 对象传给 Modal.Root，
 * 渲染 Modal compound 结构（Backdrop 遮罩 + Container 居中容器）。
 * 子组件（DialogContent）在 Container 内渲染，自身映射为 Modal.Dialog。
 */
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  /* 受控模式：isOpen 取自外部 open，状态变化时回调 onOpenChange */
  const state = useOverlayState({ isOpen: open, onOpenChange });

  return (
    <Modal state={state}>
      {/* 遮罩层：点击可关闭（isDismissable 默认 true） */}
      <Modal.Backdrop className="bg-black/50" />
      <Modal.Container className="flex items-center justify-center">
        {children}
      </Modal.Container>
    </Modal>
  );
}

/**
 * Dialog 视觉容器。映射到 Modal.Dialog，承载 Header/Body/Footer。
 * onClose 传入时会渲染右上角关闭按钮（用 Modal.CloseTrigger，点击即关闭并触发 onOpenChange(false)）。
 */
export function DialogContent({
  children,
  className,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  /** 关闭回调；传入才会显示关闭按钮。HeroUI CloseTrigger 会自动触发 state.close → onOpenChange(false) */
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <Modal.Dialog
      className={cn(
        /* 视觉样式：圆角、边框、卡片背景、内边距、阴影、最大高度 + 滚动 */
        "relative rounded-xl border border-border bg-surface p-4 md:p-6 shadow-lg max-h-[90dvh] overflow-y-auto outline-none",
        /* 宽度：移动端占满（留 1rem 边距），桌面端居中固定宽度 */
        "w-[calc(100%-2rem)] sm:max-w-sm md:max-w-md md:mx-auto mx-4",
        className
      )}
    >
      {/* 关闭按钮：用 HeroUI CloseTrigger，自动触发关闭并联动 onOpenChange */}
      {onClose && (
        <Modal.CloseTrigger
          aria-label={t("common.close")}
          className="absolute right-3 top-3 rounded-md p-2.5 md:p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-muted-foreground hover:text-foreground active:bg-accent transition-colors"
        >
          <X className="size-4" />
        </Modal.CloseTrigger>
      )}
      {children}
    </Modal.Dialog>
  );
}

/** 标题区容器 */
export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-1.5", className)}>{children}</div>;
}

/** 标题文字 */
export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-lg font-semibold", className)}>{children}</h2>;
}

/** 描述文字 */
export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

/** 底部操作区（按钮组右对齐） */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-6 flex items-center justify-end gap-2", className)}>
      {children}
    </div>
  );
}
