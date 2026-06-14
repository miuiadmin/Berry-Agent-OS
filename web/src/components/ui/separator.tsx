/**
 * Separator 分隔线组件（基于 Base UI 原语）。
 *
 * 视觉分割元素：横向（默认）或纵向细线，常用于卡片内分节、表单分组。
 *
 * 用法：
 *   <Separator />                              // 横向，w-full
 *   <Separator orientation="vertical" />       // 纵向，self-stretch
 *
 * 结构性重构：横向/纵向差异类抽成 Record，比单条 data-horizontal:/data-vertical:
 * 并列的长字符串更易读。
 */

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

/** 朝向差异：横向 h-px w-full / 纵向 w-px self-stretch */
const ORIENTATION_CLASS: Record<"horizontal" | "vertical", string> = {
  // 注意：Base UI Separator 暴露 data-orientation="horizontal|vertical"（非裸 data-horizontal），
  // 必须用 data-[orientation=...]: 才能命中，否则纵向分隔线会塌成 0 宽度。
  horizontal: "data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full",
  vertical: "data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
}

/**
 * @param orientation horizontal（默认）/ vertical
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        ORIENTATION_CLASS[orientation],
        className
      )}
      {...props}
    />
  )
}

export { Separator }
