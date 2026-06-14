/**
 * CopyButton 通用复制按钮组件。
 *
 * 点击写入剪贴板，1.5s 内显示 ✓ + "已复制" 文字反馈。失败时静默（剪贴板被拒 / 非安全上下文）。
 * 消除 message-bubble-parts 与 code-block 中的重复实现。
 *
 * 移动端硬规则：44×44 触控目标（TOUCH_TARGET），桌面端紧凑（md: 收回）。
 * 成功反馈用文字 + 图标双通道（移动端无 hover 时仍可感知，满足无 hover 反馈硬规则）。
 *
 * 用法：
 *   <CopyButton text={code} />
 *   <CopyButton text={url} className="text-foreground" />
 *
 * 结构性重构：触控目标类抽到 _shared.TOUCH_TARGET（与 IconButton / EmptyState 等共用）；
 * 复制定时器逻辑提取为命名清晰的副作用 + 清理。
 */

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"
import { TOUCH_TARGET } from "@/components/ui/_shared"

/** 反馈态持续时间（ms）：点击后显示 ✓ 1.5s 自动复位 */
const COPIED_FEEDBACK_MS = 1500

export function CopyButton({ text, className }: { text: string; className?: string }) {
  /** 复制成功反馈态（COPIED_FEEDBACK_MS 后自动复位） */
  const [copied, setCopied] = useState(false)
  const t = useT()
  /** 反馈态定时器引用，卸载时清除避免泄漏 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载时清理定时器，避免 setState on unmounted 警告 + 内存泄漏
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleCopy = useCallback(() => {
    // 空值守卫：空串/undefined 不写剪贴板，避免静默覆盖用户原剪贴板内容。
    // 调用方一般会传有效值，但组件作为通用 API 应自保。
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      // 复位已有定时器再起新的，避免连续点击时反馈闪烁
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    }).catch(() => { /* clipboard access denied or insecure context — 静默失败 */ })
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent",
        TOUCH_TARGET,
        "md:px-1.5 md:py-1",
        className
      )}
      aria-label={t("chat.copy")}
    >
      {copied ? (
        <>
          <Check className="size-3 animate-fade-scale" />
          {/* 成功态文字反馈：移动端无 hover 时仍可感知（图标 + 文案双通道） */}
          <span className="animate-fade-in">{t("chat.copied")}</span>
        </>
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  )
}
