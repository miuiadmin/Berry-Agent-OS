"use client";

import { useState, useCallback, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  content: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

export function Tooltip({ content, side = "top", children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  let hideTimer: ReturnType<typeof setTimeout>;

  const show = useCallback(() => {
    clearTimeout(hideTimer);
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    hideTimer = setTimeout(() => setVisible(false), 150);
  }, []);

  const toggle = useCallback(() => {
    setVisible((v) => !v);
  }, []);

  const positionClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={toggle}
    >
      {children}
      {visible && (
        <div
          className={cn(
            "absolute z-50 whitespace-nowrap rounded-md bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md border border-border",
            "animate-in fade-in-0 zoom-in-95",
            positionClasses[side]
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      )}
    </div>
  );
}
