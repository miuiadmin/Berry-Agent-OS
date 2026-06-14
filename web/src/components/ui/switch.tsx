/**
 * Switch 开关组件（基于 Base UI 原语）。
 *
 * 二态切换控件，受控用法：`<Switch checked={v} onCheckedChange={setV} />`。
 * 尺寸变体：default（32×18px）/ sm（24×14px），均带扩展点击区（after 伪元素）。
 * 选中态使用 brand 品牌色，未选中态使用 input 中性色。
 *
 * 结构性重构：
 * - aria-invalid 红环 + 聚焦环抽到 _shared（与其他表单原语共享）。
 * - 把 track / thumb 在两种 size 下的尺寸 + 平移量拆成 Record，
 *   group-data 选择器字符串集中在一处可读，新增 size 只加一行。
 */

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"
import { FOCUS_RING, ARIA_INVALID_RING } from "@/components/ui/_shared"

/** 尺寸变体 → track 宽高（default 32×18.4px / sm 24×14px） */
const TRACK_SIZE: Record<"default" | "sm", string> = {
  default: "data-[size=default]:h-[18.4px] data-[size=default]:w-[32px]",
  sm: "data-[size=sm]:h-[14px] data-[size=sm]:w-[24px]",
}

/** 尺寸变体 → thumb 大小 + 选中/未选中平移量 */
const THUMB_GEOMETRY: Record<"default" | "sm", string> = {
  default: [
    "group-data-[size=default]/switch:size-4",
    // 选中：向右平移 (track宽 - thumb宽 - 边距) ≈ 100%-2px
    "group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)]",
    "group-data-[size=default]/switch:data-unchecked:translate-x-0",
  ].join(" "),
  sm: [
    "group-data-[size=sm]/switch:size-3",
    "group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)]",
    "group-data-[size=sm]/switch:data-unchecked:translate-x-0",
  ].join(" "),
}

/**
 * @param size default / sm
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  /** 尺寸变体：default（32×18px）/ sm（24×14px） */
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        [
          "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all",
          // after 伪元素扩展点击区（无障碍：手指/鼠标偏离 track 仍可触发）
          "after:absolute after:-inset-x-3 after:-inset-y-2",
          FOCUS_RING,
          ARIA_INVALID_RING,
          // 尺寸由 data-size 属性驱动，从 RECORD 取
          TRACK_SIZE[size],
          // 选中态 brand 色 / 未选中 input 中性色（含 dark 变体）
          "data-checked:bg-brand data-unchecked:bg-input dark:data-unchecked:bg-input/80",
          // disabled：禁用 + 半透明
          "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        ],
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          [
            "pointer-events-none block rounded-full bg-background ring-0 transition-transform",
            // thumb 几何（大小 + 平移）从 RECORD 取
            THUMB_GEOMETRY[size],
            // dark 模式下选中/未选中 thumb 颜色
            "dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground",
          ]
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
