/**
 * Separator 分隔线组件（基于 Base UI 原语）。
 *
 * 视觉分割元素：横向（默认）或纵向细线，常用于卡片内分节、表单分组。
 *
 * 用法：
 *   <Separator />                              // 横向，w-full
 *   <Separator orientation="vertical" />       // 纵向，self-stretch
 */

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

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
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
