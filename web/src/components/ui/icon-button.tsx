/**
 * IconButton 统一的「纯图标」按钮组件。
 *
 * 消除各页面里反复手写的同一段实现：
 *   `<Button variant="ghost" size="icon" className="size-11 md:size-8"
 *           title=... aria-label=... onClick=...>`
 *
 * 设计要点：
 * - 移动端固定 44px、桌面端 32px 的方形触控目标（移动端适配硬规则）。
 * - `title` 同时渲染为原生 title 提示与 aria-label 无障碍标签，
 *   避免每个图标按钮都把同一句文案写两遍。
 * - `onClick` 透传原生鼠标事件，便于在卡片内调用 stopPropagation。
 * - `type` 透传给底层 button（默认 'button'，不触发 form submit）。
 *   重要：HTML button 默认 type='submit'，若 IconButton 出现在 form 内且未显式
 *   传 type='button'，点击会触发表单提交。这里默认 'button' 杜绝该隐患。
 * - `variant` 透传给底层 Button variant（默认 'ghost'，保留历史行为）。
 *   destructive 操作通过 destructive prop 染色即可，无需改 variant。
 * - `className` 追加（而非覆盖）基础类，支持如 `animate-spin` 的临时态。
 *
 * 适用范围：纯图标操作按钮（删除 / 刷新 / 启用切换 等）。
 * 不适用：带文字的按钮（用 `min-h-[44px]` 那套尺寸）、
 * 圆形悬浮按钮（FAB）——这些是不同的尺寸/形态，不要强行塞进来。
 */

import type { MouseEventHandler, ReactNode } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import type { VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/** Button variant 类型，透传给底层 Button */
type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>

export function IconButton({
  title,
  disabled,
  onClick,
  destructive,
  variant = "ghost",
  type = "button",
  className,
  children,
}: {
  /** 按钮文案：同时用作 title 提示与 aria-label，图标按钮必须有无障碍标签 */
  title: string
  /** 是否禁用 */
  disabled?: boolean
  /** 点击处理；透传原生鼠标事件，便于 stopPropagation 等场景 */
  onClick?: MouseEventHandler<HTMLButtonElement>
  /** 危险操作（删除等）：hover 态染红，提示破坏性后果 */
  destructive?: boolean
  /** Button variant（默认 ghost，保留历史行为） */
  variant?: ButtonVariant
  /**
   * 原生 button type 属性。
   * 默认 'button'，确保在 form 内点击不会意外触发提交。
   * 需要提交时显式传 'submit'。
   */
  type?: "button" | "submit" | "reset"
  /** 追加到基础尺寸之后的 className（如加载中 `animate-spin`） */
  className?: string
  /** 图标内容 */
  children: ReactNode
}) {
  return (
    <Button
      variant={variant}
      size="icon"
      type={type}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // 移动端 44px / 桌面端 32px 方形触控目标
        "size-11 md:size-8",
        destructive && "text-destructive hover:text-destructive",
        className,
      )}
    >
      {children}
    </Button>
  )
}
