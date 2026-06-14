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
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/** @param type 原生 input type（text/email/password/number...） */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 md:h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
