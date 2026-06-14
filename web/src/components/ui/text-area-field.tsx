/**
 * TextAreaField 统一多行文本输入组件。
 *
 * 替代 MemoryPage / SchedulerPage / CreateJobCard 中重复的 raw `<textarea>` 样式。
 * 自动处理移动端字体缩放（16px 防止 iOS 自动缩放）和桌面端标准字号。
 * 支持 forwardRef（EditableMessage 需要直接操作 DOM 自适应高度）。
 *
 * 用法：
 *   <TextAreaField placeholder="..." value={text} onChange={e => setText(e.target.value)} />
 *   <TextAreaField ref={ref} rows={4} className="font-mono" />
 *
 * 结构性重构：聚焦环 / aria-invalid 红环抽到 _shared 常量（与 Input 共享），
 * 消除两份漂移的同一段类字符串。
 */

import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import { FOCUS_RING, ARIA_INVALID_RING } from "@/components/ui/_shared"

interface TextAreaFieldProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 自定义容器 className */
  className?: string
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ className, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          [
            "flex w-full rounded-md border border-input bg-transparent px-3 py-2",
            // 移动端 text-[16px] 防 iOS 聚焦自动缩放，桌面端 md:text-sm
            "text-[16px] md:text-sm",
            "ring-offset-background",
            "placeholder:text-muted-foreground",
            FOCUS_RING,
            ARIA_INVALID_RING,
          ],
          className
        )}
        {...props}
      />
    )
  },
)
