/**
 * Tooltip 提示气泡组件集（基于 Base UI 原语）。
 *
 * 鼠标 hover / 键盘聚焦时弹出的小气泡，常放图标按钮的解释文案。
 * 注意：触屏设备无 hover，关键操作不要只依赖 Tooltip 传达。
 *
 * 组合用法：
 *   <TooltipProvider>
 *     <Tooltip>
 *       <TooltipTrigger render={<Button />}>...</TooltipTrigger>
 *       <TooltipContent side="top">提示文案</TooltipContent>
 *     </Tooltip>
 *   </TooltipProvider>
 *
 * side：top / right / bottom / left（默认 top），align：center / start / end。
 *
 * 结构性重构：
 * - 把 TooltipContent 近 600 字符的 className 按段拆分注释（气泡样式 / 进出场动画 / 箭头定位）。
 * - 6 个方向的 slide-in 位移类用 Record 集中（原本是单条 6 段并列 data-[side=...] 字符串）。
 * - 箭头 6 个方向的偏移类同样用 Record 集中（原本是一行 600 字符 className）。
 *
 * 修复 Base UI 迁移残留：旧代码用了 `data-[state=delayed-open]:` 选择器，
 * 那是 Radix UI 的属性名（data-state + delayed-open），Base UI Tooltip Popup
 * 实际暴露的是 `data-open` / `data-closed` / `data-starting-style` / `data-ending-style`
 * （见 TooltipPopupDataAttributes）。原代码的 hover 延迟态动画类全部是死 CSS，
 * 永不命中。现已改为 Base UI 的标准进出场选择器。
 */

"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

/**
 * Tooltip 默认显示延迟（ms）。
 * 设为 400 而非 0：避免鼠标快速扫过触发器时 tooltip 立即弹出干扰视觉。
 * 调用方仍可显式传 delay={0} 覆盖为立即显示。
 */
const DEFAULT_HOVER_DELAY = 400

/** 6 个弹出方向 → 进场位移（slide-in-from-*）映射 */
const SLIDE_IN_BY_SIDE: Record<string, string> = {
  top: "data-[side=top]:slide-in-from-bottom-2",
  bottom: "data-[side=bottom]:slide-in-from-top-2",
  left: "data-[side=left]:slide-in-from-right-2",
  right: "data-[side=right]:slide-in-from-left-2",
  "inline-start": "data-[side=inline-start]:slide-in-from-right-2",
  "inline-end": "data-[side=inline-end]:slide-in-from-left-2",
}

/**
 * 6 个弹出方向 → 箭头定位偏移映射。
 *
 * 箭头是一个 45° 旋转的小方块，需要根据气泡相对于触发器的方向贴到对应边：
 * - top：箭头在底部（-bottom-2.5）
 * - bottom：箭头在顶部（top-1）
 * - left / inline-start：箭头在右侧，纵向居中（-right-1 + 上下居中）
 * - right / inline-end：箭头在左侧，纵向居中（-left-1 + 上下居中）
 *
 * 拆成 Record 与 SLIDE_IN_BY_SIDE 风格对齐，原本是一行 600 字符的并列 className。
 */
const ARROW_POSITION_BY_SIDE: Record<string, string> = {
  top: "data-[side=top]:-bottom-2.5",
  bottom: "data-[side=bottom]:top-1",
  left: "data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2",
  right: "data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2",
  "inline-start":
    "data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2",
  "inline-end":
    "data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2",
}

/**
 * Provider：全局 Tooltip 配置。
 * @param delay 显示延迟（ms，默认 400，避免鼠标扫过时立即弹出）
 */
function TooltipProvider({
  delay = DEFAULT_HOVER_DELAY,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

/** Tooltip 根：管理 open/close 状态 */
function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

/** 触发器：hover/focus 时打开气泡（render 包裹目标元素） */
function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * 气泡内容（自动 Portal + 定位 + 箭头）。
 * @param side 顶/右/底/左（默认 top）
 * @param sideOffset 与触发器的距离（px，默认 4）
 * @param align 对齐方式（默认 center）
 */
function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            [
              // 气泡基础样式：深色底 + 浅色文字 + 圆角 + 最大宽度约束
              "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background",
              // 含 kbd 子元素时右侧收紧
              "has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm",
              // 进出场动画：Base UI 用 data-open/data-closed + data-starting-style/data-ending-style，
              // 不是 Radix 的 data-[state=delayed-open]（那是不存在的属性，旧代码是死 CSS）。
              // data-open:animate-in 在气泡进入时触发淡入+缩放，data-closed:animate-out 在离开时反向。
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              // 方向位移（从 Record 取，6 个方向）
              Object.values(SLIDE_IN_BY_SIDE).join(" "),
            ],
            className
          )}
          {...props}
        >
          {children}
          {/*
            箭头：45° 旋转的小方块，按方向贴边定位。
            基础类（尺寸/旋转/配色）固定，方向偏移从 ARROW_POSITION_BY_SIDE 取并 join，
            替代原来一行 600 字符的并列 data-[side=...] className。
          */}
          <TooltipPrimitive.Arrow
            className={cn(
              "z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground",
              Object.values(ARROW_POSITION_BY_SIDE).join(" "),
            )}
          />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
