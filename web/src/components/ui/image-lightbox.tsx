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
 *
 * 注意：必须无条件调用（不依赖 src 是否为空）—— src 为空时 short-circuit，
 * 这样调用方在 src 从有值变 undefined（或反之）时 hook 数量保持恒定，
 * 避免触发 React 'Rendered fewer hooks than expected' 崩溃。
 * @param src 图片 URL（变化时重置；空串时不触发监听，直接停留初始态）
 * @returns { error, loaded, handleError, handleLoad }
 */
function useImageLoad(src: string) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // src 切换时同步重置 error + loaded（loaded 重置会在下一帧 img onLoad 前先显示占位骨架，
  // 避免"旧图 loaded=true 留存"导致的状态污染）。
  // 空串短路：无 src 时不应重置（避免无意义渲染），同时也作为 hook 调用方
  // 在 src 为 undefined → '' 传参下的稳定行为。
  useEffect(() => {
    if (!src) return
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
  /**
   * onClose 的 ref 容器：把回调挂进 ref，避免回调进 handleKeyDown 依赖。
   *
   * 关键原因：调用方（如 ClickableImage）通常传内联箭头 `() => setOpen(false)`，
   * 每次父渲染 onClose 引用都变。若直接进 handleKeyDown 依赖 → keydown effect 频繁 re-run
   * → prevFocusRef.current 被反复覆盖为当前 activeElement（可能已不是打开前的元素），
   * 关闭时会 focus 到错误元素。ref 方案让 effect 依赖只剩 [open]，稳定。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // ESC 处理器：依赖为空 → 引用稳定，永不重建
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onCloseRef.current()
  }, [])

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
  // 关键：useImageLoad 必须在任何 early return 之前无条件调用。
  // src 可能为 undefined，此时传 ''（hook 内部 short-circuit），保证 src 在
  // 有值/undefined 之间切换时 hook 数量恒定，避免 React
  // 'Rendered fewer hooks than expected' 崩溃。
  const { error, loaded, handleError, handleLoad } = useImageLoad(src ?? "")

  // 无 src：不渲染（避免空 img 占位）。
  // 此时 useImageLoad 已调用过，hook 数量与有 src 时一致。
  if (!src) return null

  // 加载失败：展示错误占位（不破坏页面布局）
  if (error) return <ImageError className={className} message={alt || t("lightbox.imageFailedToLoad")} />

  return (
    <>
      {/*
        缩略图可点击区域：
        - cursor-pointer 暗示可点击（桌面 + 触屏均生效）
        - 触屏可见的角标（右上角放大镜）作为 hover 之外的『可放大』视觉提示，
          满足 CLAUDE.md 硬规则（不依赖 :hover 作为唯一交互反馈）。
          角标在桌面端 hover 时也显示，移动端常驻。
      */}
      <div className={cn("group relative my-2 inline-block", className)}>
        <img src={src} alt={alt || ""}
          className={cn("block max-h-80 max-w-full cursor-pointer rounded-lg transition-all duration-300 hover:opacity-90", loaded ? "opacity-100" : "opacity-0")}
          onClick={() => setOpen(true)}
          onError={handleError} onLoad={handleLoad} />
        {/* 触屏可见的『可放大』角标（桌面端 hover 显示，移动端常驻） */}
        <span aria-hidden
          className="pointer-events-none absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-black/55 text-white opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </span>
      </div>
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
