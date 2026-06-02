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

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (open) {
      setClosing(false);
    } else if (prevOpenRef.current && !open) {
      setClosing(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open && !closing) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleEsc);
    if (open || closing) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, closing, onOpenChange]);

  if (!open && !closing) return null;

  const isExiting = closing && !open;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => {
        if (isExiting) return;
        if (e.target === overlayRef.current) onOpenChange(false);
      }}
    >
      <div className={cn("fixed inset-0 bg-black/50", isExiting ? "animate-overlay-out" : "animate-overlay-in")} />
      <div
        className={cn(
          "relative z-50 w-[calc(100%-2rem)] sm:max-w-sm md:max-w-md md:mx-auto mx-4",
          isExiting ? "animate-sheet-out" : "animate-sheet-in"
        )}
        onAnimationEnd={() => { if (isExiting) setClosing(false); }}
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
