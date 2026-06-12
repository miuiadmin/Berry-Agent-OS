"use client";

import { useState } from "react";
import { X, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

/**
 * 图片灯箱 — 用 Dialog 适配器（HeroUI Modal）承载。
 *
 * ESC 关闭、遮罩点击关闭、焦点陷阱、焦点恢复、body 滚动锁定全部由
 * Dialog（react-aria Modal）内置提供，不再手写 keydown/overflow/focus 逻辑。
 */
export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const t = useT();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* 全屏暗色遮罩容器，覆盖默认 DialogContent 的卡片样式 */}
      <DialogContent
        onClose={onClose}
        aria-label={alt || t("lightbox.image")}
        className="bg-black/80 backdrop-blur-sm border-none shadow-none p-0 w-screen h-screen max-w-none max-h-none mx-0 rounded-none flex items-center justify-center"
      >
        {/* 关闭按钮放左上（避开图片） */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute top-[calc(1rem+env(safe-area-inset-top,0px))] right-4 z-10 text-white hover:bg-white/10 hover:text-white"
        >
          <X className="size-5" />
        </Button>
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
              loaded ? "opacity-100" : "opacity-0",
            )}
            onClick={(e) => e.stopPropagation()}
            onError={() => setError(true)}
            onLoad={() => setLoaded(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 可点击图片 — 内联渲染缩略图，点击弹出全屏 ImageLightbox。
 * 加载失败时显示降级的图文提示。
 */
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
          className,
        )}
        onClick={() => setOpen(true)}
        onError={() => setError(true)}
        onLoad={() => setLoaded(true)}
      />
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
