/**
 * Badge 徽章组件（基于 Base UI useRender）。
 *
 * 小尺寸状态标签，常放表格行尾、按钮旁、卡片角标。
 * 使用 useRender 模式，可通过 `render={<a />}` 复用为可点击元素。
 *
 * variant：
 * - default  主色填充
 * - secondary 辅助填充
 * - destructive / success / warning  语义状态（幽灵背景，用于错误/在线/未就绪等）
 * - outline  描边
 * - ghost    悬浮态填充
 * - link     文字链接
 *
 * 结构性重构：基础类中重复的聚焦环 / aria-invalid 红环抽到 _shared 常量；
 * variant 里 destructive / success / warning 三种语义态高度同构
 * （都是 10% 背景 + 同色文字 + 20% hover），抽成工厂函数避免三份漂移。
 */

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { FOCUS_RING, ARIA_INVALID_RING } from "@/components/ui/_shared"

/**
 * 语义态徽章字典：destructive / success / warning 三种 variant 高度同构。
 * 统一模式：10% 背景 + 同色文字 + 20% hover/dark 背景 + 同色 20% 聚焦环。
 *
 * 注意：不能用模板字符串拼接（如 `bg-${color}/10`）—— Tailwind 4 的 JIT
 * 扫描源码时只识别完整字面量类名，拼接出来的类不会被生成。
 * 这里用 Record 显式列出每个完整类名，safelist 也能扫到。
 */
const SEMANTIC_VARIANTS = {
  destructive:
    "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
  /** 成功状态徽章（绿色，幽灵式背景，用于运行中/在线等正向状态） */
  success:
    "bg-success/10 text-success focus-visible:ring-success/20 dark:bg-success/20 dark:focus-visible:ring-success/40 [a]:hover:bg-success/20",
  /** 警告状态徽章（黄色，幽灵式背景，用于警告/未就绪等中间状态） */
  warning:
    "bg-warning/10 text-warning focus-visible:ring-warning/20 dark:bg-warning/20 dark:focus-visible:ring-warning/40 [a]:hover:bg-warning/20",
} as const

/** 徽章样式合成器（cva）：variant 维度 + 公共基础类 */
const badgeVariants = cva(
  [
    "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all",
    FOCUS_RING,
    ARIA_INVALID_RING,
    // 含图标时左右内边距收紧（与 Button 一致的 has-data 模式）
    "has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
    // 子 svg 默认尺寸 + 不响应指针
    "[&>svg]:pointer-events-none [&>svg]:size-3!",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // 三种语义态从字典取，新增同类状态只加一行
        destructive: SEMANTIC_VARIANTS.destructive,
        success: SEMANTIC_VARIANTS.success,
        warning: SEMANTIC_VARIANTS.warning,
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * Badge 组件。
 * @param variant 视觉变体（默认 default）
 * @param render Base UI render prop（如 `render={<a href />}`）
 */
function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
