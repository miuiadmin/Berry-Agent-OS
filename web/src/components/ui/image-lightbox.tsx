/**
 * ImageLightbox 图片灯箱组件集。
 *
 * - ImageLightbox：全屏覆盖层查看大图（ESC 关闭、点击背景关闭、焦点管理 + body 滚动锁定）
 * - ClickableImage：内联缩略图，点击打开灯箱
 *
 * 结构性重构：两个组件共享 error/loaded 双态模式原本各写一遍（2 × useState +
 * onError/onLoad handler），抽出 useImageLoad hook 统一，消除两份漂移的同一段状态机。
 */

"use client"

import { useEffect, useCallback, useRef, useState } from "react"
import { X, ImageOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"

/**
 * 图片加载状态 hook：error / loaded 双态。
 * 切换 src 时同时重置 error 与 loaded，保证状态机对 src 单调：
 * 旧图已加载的 loaded=true 不会污染新图（否则后续若调整 error/loaded 判定顺序会出 bug）。
 * @param src 图片 URL（变化时重置）
 * @returns { error, loaded, handleError, handleLoad }
 */
function useImageLoad(src: string) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // src 切换时同步重置 error + loaded（loaded 重置会在下一帧 img onLoad 前先显示占位骨架，
  // 避免"旧图 loaded=true 留存"导致的状态污染）
  useEffect(() => {
    setError(false)
    setLoaded(false)
  }, [src])

  return {
    error,
    loaded,
    handleError: useCallback(() => setError(true), []),
    handleLoad: useCallback(() => setLoaded(true), []),
  }
}

/** 图片加载错误占位（图标 + 文案） */
function ImageError({ className, message }: { className?: string; message: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground", className)}>
      <ImageOff className="size-4" />
      <span>{message}</span>
    </div>
  )
}

interface ImageLightboxProps {
  /** 大图 URL */
  src: string
  /** alt 文案（同时作为 dialog aria-label） */
  alt?: string
  /** 是否打开 */
  open: boolean
  /** 关闭回调 */
  onClose: () => void
}

/**
 * 全屏灯箱。
 * 打开时锁定 body 滚动 + 监听 ESC + 记录原焦点用于关闭恢复。
 * 关闭按钮移动端 44px、桌面端 36px 触控目标。
 */
export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  const { error, loaded, handleError, handleLoad } = useImageLoad(src)
  const t = useT()
  /** 打开前的焦点元素，关闭时恢复（无障碍） */
  const prevFocusRef = useRef<HTMLElement | null>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    prevFocusRef.current = document.activeElement as HTMLElement
    document.addEventListener("keydown", handleKeyDown)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.body.style.overflow = ""
      prevFocusRef.current?.focus()
      prevFocusRef.current = null
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return (
    <div role="dialog" aria-modal="true" aria-label={alt || t("lightbox.image")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}>
      {/* 关闭按钮：移动端 44px、桌面端 36px */}
      <button onClick={onClose}
        className="absolute top-[calc(1rem+env(safe-area-inset-top,0px))] right-4 z-10 flex size-11 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 active:bg-black/70 md:size-9"
        aria-label={t("common.close")}>
        <X className="size-5" />
      </button>
      {error ? (
        <div className="flex flex-col items-center gap-3 text-white/60">
          <ImageOff className="size-12" />
          <span className="text-sm">{t("lightbox.failedToLoad")}</span>
        </div>
      ) : (
        <img src={src} alt={alt || ""}
          className={cn("max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")}
          onClick={(e) => e.stopPropagation()}
          onError={handleError} onLoad={handleLoad} />
      )}
    </div>
  )
}

/** 可点击图片（内联缩略图 → 点击打开灯箱） */
export function ClickableImage({ src, alt, className }: { src?: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const t = useT()

  // 无 src：不渲染（避免空 img 占位）
  if (!src) return null

  const { error, loaded, handleError, handleLoad } = useImageLoad(src)

  // 加载失败：展示错误占位（不破坏页面布局）
  if (error) return <ImageError className={className} message={alt || t("lightbox.imageFailedToLoad")} />

  return (
    <>
      <img src={src} alt={alt || ""}
        className={cn("my-2 max-h-80 max-w-full cursor-pointer rounded-lg transition-all duration-300 hover:opacity-90", loaded ? "opacity-100" : "opacity-0", className)}
        onClick={() => setOpen(true)}
        onError={handleError} onLoad={handleLoad} />
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
