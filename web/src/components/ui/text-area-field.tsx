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
 */

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

interface TextAreaFieldProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 自定义容器 className */
  className?: string;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ className, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          "flex w-full rounded-md border bg-transparent px-3 py-2",
          "text-[16px] md:text-sm ring-offset-background",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
    );
  },
);
