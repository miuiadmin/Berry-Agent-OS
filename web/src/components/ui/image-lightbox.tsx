"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { X, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const t = useT();

  /** 打开前记录焦点元素，关闭时恢复 */
  const previousFocusRef = useState(() => null as HTMLElement | null)[0];
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    // 保存当前焦点
    prevFocusRef.current = document.activeElement as HTMLElement;
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      // 关闭时恢复焦点
      if (prevFocusRef.current) {
        prevFocusRef.current.focus();
        prevFocusRef.current = null;
      }
    };
  }, [open, handleKeyDown]);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || t("lightbox.image")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-[calc(1rem+env(safe-area-inset-top,0px))] right-4 z-10 flex size-11 md:size-9 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 active:bg-black/70 transition-colors"
        aria-label={t("common.close")}
      >
        <X className="size-5" />
      </button>
      {error ? (
        <div className="flex flex-col items-center gap-3 text-white/60">
          <ImageOff className="size-12" />
          <span className="text-sm">{t("lightbox.failedToLoad")}</span>
        </div>
      ) : (
        <img
          src={src}
          alt={alt || ""}
          className={cn(
            "max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onClick={(e) => e.stopPropagation()}
          onError={() => setError(true)}
          onLoad={() => setLoaded(true)}
        />
      )}
    </div>
  );
}

export function ClickableImage({
  src,
  alt,
  className,
}: {
  src?: string;
  alt?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const t = useT();

  if (!src) return null;

  if (error) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground", className)}>
        <ImageOff className="size-4" />
        <span>{alt || t("lightbox.imageFailedToLoad")}</span>
      </div>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ""}
        className={cn(
          "rounded-lg max-w-full max-h-80 cursor-pointer hover:opacity-90 transition-all duration-300 my-2",
          loaded ? "opacity-100" : "opacity-0",
          className
        )}
        onClick={() => setOpen(true)}
        onError={() => setError(true)}
        onLoad={() => setLoaded(true)}
      />
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
