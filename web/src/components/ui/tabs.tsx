/**
 * Tabs 标签页组件集（基于 Base UI 原语）。
 *
 * 标签页切换：Tabs（根）+ TabsList（标签条）+ TabsTrigger（单个标签）
 * + TabsContent（对应面板）。
 *
 * TabsList variant：
 * - default  灰底圆角胶囊（默认）
 * - line     底部细线指示器（无背景）
 *
 * 用法：
 *   <Tabs defaultValue="a">
 *     <TabsList>
 *       <TabsTrigger value="a">A</TabsTrigger>
 *       <TabsTrigger value="b">B</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="a">...</TabsContent>
 *     <TabsContent value="b">...</TabsContent>
 *   </Tabs>
 *
 * orientation 默认 horizontal（横向），可设 vertical（侧栏式纵向）。
 *
 * 结构性重构：TabsTrigger 那条拼接了 5 段的长 className 拆成命名段
 * （TRIGGER_BASE / TRIGGER_ACTIVE / TRIGGER_LINE_VARIANT / TRIGGER_INDICATOR），
 * 每段语义明确，line 变体的差异集中在一处。
 */

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { FOCUS_RING } from "@/components/ui/_shared"

/**
 * Tabs 根容器。
 * @param orientation horizontal（默认）/ vertical
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        // data-[orientation=horizontal]:flex-col —— Base UI Tabs Root 暴露
        // data-orientation="horizontal|vertical"（非裸 data-horizontal），用方括号语法才能命中。
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

/** 标签条容器样式：default（胶囊灰底）/ line（无背景细线） */
const tabsListVariants = cva(
  [
    "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground",
    // 横向时固定高度 8、纵向时高度自适应 + 切到 flex-col
    // 注意：Base UI Tabs Root 暴露 data-orientation="horizontal|vertical"（非裸 data-horizontal），
    // 命名分组 group/tabs 上的状态需用 group-data-[orientation=...]/tabs: 才能匹配。
    "group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
    // line 变体去圆角
    "data-[variant=line]:rounded-none",
  ],
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/** 标签条：包裹 TabsTrigger */
function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

/** TabsTrigger 基础类（不随 variant 变化的部分） */
const TRIGGER_BASE = [
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap",
  // 纵向布局时撑满宽度 + 左对齐（命中 group/tabs 上的 data-orientation="vertical"）
  "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start",
  // 默认文字色（60% 透明），hover/active 时变实色
  "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
  FOCUS_RING,
  "focus-visible:outline-1 focus-visible:outline-ring",
  // disabled：禁用 + 半透明（aria-disabled 与原生 disabled 双覆盖）
  "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  // 含图标时收紧左右内边距
  "has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1",
  // 子 svg 默认尺寸 + 不响应指针
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
].join(" ")

/** 选中态高亮：default 变体用阴影，line 变体去掉阴影（仅底部线指示） */
const TRIGGER_ACTIVE = [
  "data-active:bg-background data-active:text-foreground",
  "dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
  // default 变体选中态加阴影
  "group-data-[variant=default]/tabs-list:data-active:shadow-sm",
  // line 变体选中态去阴影、去背景、去边框
  "group-data-[variant=line]/tabs-list:data-active:shadow-none group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
].join(" ")

/** 底部 / 侧边指示线（after 伪元素，仅 line 变体选中时可见） */
const TRIGGER_INDICATOR = [
  "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity",
  // 横向布局：指示线在底部（命中 group/tabs 上的 data-orientation="horizontal"）
  "group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5",
  // 纵向布局：指示线在右侧（命中 group/tabs 上的 data-orientation="vertical"）
  "group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5",
  // line 变体选中时显示指示线
  "group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
].join(" ")

/** 单个标签：选中态自动高亮（default 阴影 / line 底部指示线） */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        TRIGGER_BASE,
        TRIGGER_ACTIVE,
        TRIGGER_INDICATOR,
        className
      )}
      {...props}
    />
  )
}

/** 标签对应的面板（仅 active value 匹配时显示） */
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
