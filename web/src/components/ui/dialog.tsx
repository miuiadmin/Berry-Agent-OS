"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** 焦点陷阱内可聚焦的元素选择器 */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * 通用 Dialog 组件。
 *
 * 功能：
 * - 打开/关闭动画（CSS animation）
 * - ESC 键关闭
 * - 点击遮罩关闭
 * - 焦点陷阱：打开时聚焦第一个可交互元素，Tab 循环在对话框内
 * - 焦点恢复：关闭时恢复到触发元素
 * - body 滚动锁定
 * - aria-modal / role="dialog" 无障碍支持
 */
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const prevOpenRef = useRef(open);
  /** 打开前记录焦点元素，关闭时恢复 */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // 追踪 open 状态变化，控制关闭动画
  useEffect(() => {
    if (open) {
      setClosing(false);
      // 打开时保存当前焦点元素
      previousFocusRef.current = document.activeElement as HTMLElement;
    } else if (prevOpenRef.current && !open) {
      setClosing(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  // 打开时：聚焦对话框内第一个可交互元素；ESC 关闭；body 滚动锁定
  useEffect(() => {
    if (!open && !closing) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleEsc);
    if (open || closing) document.body.style.overflow = "hidden";

    // 打开时自动聚焦内容区域
    if (open && contentRef.current) {
      // 延迟一帧等待 DOM 渲染完成
      requestAnimationFrame(() => {
        if (!contentRef.current) return;
        const firstFocusable = contentRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          // 没有可聚焦元素，聚焦内容容器本身
          contentRef.current.focus();
        }
      });
    }

    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, closing, onOpenChange]);

  // 关闭动画结束后恢复焦点
  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      setClosing(false);
      // 恢复焦点到打开前的元素
      if (previousFocusRef.current && "focus" in previousFocusRef.current) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }
  }, [closing]);

  if (!open && !closing) return null;

  const isExiting = closing && !open;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => {
        if (isExiting) return;
        if (e.target === overlayRef.current) onOpenChange(false);
      }}
    >
      <div className={cn("fixed inset-0 bg-black/50", isExiting ? "animate-overlay-out" : "animate-overlay-in")} />
      <div
        ref={contentRef}
        tabIndex={-1}
        className={cn(
          "relative z-50 w-[calc(100%-2rem)] sm:max-w-sm md:max-w-md md:mx-auto mx-4 outline-none",
          isExiting ? "animate-sheet-out" : "animate-sheet-in"
        )}
        onAnimationEnd={handleAnimationEnd}
        onKeyDown={(e) => {
          // Tab 焦点陷阱：Tab 和 Shift+Tab 在对话框内循环
          if (e.key !== "Tab" || !contentRef.current) return;
          const focusable = contentRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey) {
            // Shift+Tab 从第一个元素跳到最后一个
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            // Tab 从最后一个元素跳到第一个
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogContent({
  children,
  className,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "relative rounded-xl border border-border bg-card p-4 md:p-6 shadow-lg max-h-[90dvh] overflow-y-auto",
        className
      )}
    >
      {onClose && (
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-3 top-3 rounded-md p-2.5 md:p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-muted-foreground hover:text-foreground active:bg-accent transition-colors"
        >
          <X className="size-4" />
        </button>
      )}
      {children}
    </div>
  );
}

export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-1.5", className)}>{children}</div>;
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-lg font-semibold", className)}>{children}</h2>;
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-6 flex items-center justify-end gap-2", className)}>
      {children}
    </div>
  );
}
