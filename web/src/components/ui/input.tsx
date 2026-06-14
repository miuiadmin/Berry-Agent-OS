/**
 * Input 文本输入框组件。
 *
 * 受控/非受控皆可，透传原生 input 属性。移动端硬规则：
 * - 高度 h-10（40px 触控目标）→ 桌面端 md:h-8
 * - 字号 text-base（防 iOS 聚焦自动缩放）→ 桌面端 md:text-sm
 *
 * 用法：
 *   <Input value={v} onChange={e => setV(e.target.value)} placeholder="..." />
 *   <Input type="password" aria-invalid={!!err} />
 *
 * 结构性重构：聚焦环 / aria-invalid 红环抽到 _shared 常量，与 Button / Badge /
 * Switch 共享同一事实源（原本是 4 处漂移的同一段类字符串）。
 */

import * as React from "react"

import { cn } from "@/lib/utils"
import { FOCUS_RING, ARIA_INVALID_RING } from "@/components/ui/_shared"

/** @param type 原生 input type（text/email/password/number...） */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        [
          "h-10 md:h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors",
          // file input 内联样式（按钮 + 文件名两段，分别约束尺寸）
          "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground",
          FOCUS_RING,
          ARIA_INVALID_RING,
          // disabled：禁用指针 + 改色（input 用 cursor-not-allowed，与 button 区分）
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50",
          // dark 模式背景与 disabled 加深
          "dark:bg-input/30 dark:disabled:bg-input/80",
          "md:text-sm",
        ],
        className
      )}
      {...props}
    />
  )
}

export { Input }
