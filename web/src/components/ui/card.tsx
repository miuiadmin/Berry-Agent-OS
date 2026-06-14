/**
 * Card 卡片组件集（基于 Base UI 原语）。
 *
 * 卡片 = 内容容器，结构：Header（Title + Description + Action） / Content / Footer。
 * size 变体：default / sm，sm 变体内边距更紧凑。
 *
 * 组合用法：
 *   <Card>
 *     <CardHeader>
 *       <CardTitle>标题</CardTitle>
 *       <CardDescription>副标题</CardDescription>
 *       <CardAction><Button>...</Button></CardAction>
 *     </CardHeader>
 *     <CardContent>正文</CardContent>
 *     <CardFooter>底部</CardFooter>
 *   </Card>
 *
 * 使用 --card-spacing CSS 变量统一内边距（4/3 由 size 决定）。
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Card 根容器。
 * @param size default（内边距 4）/ sm（内边距 3）
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

/** 头部容器：栅格布局，含 CardAction 时自动右列对齐 */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

/** 卡片标题（font-heading 字体，sm 尺寸随 Card size 缩小） */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

/** 描述文字（muted 灰色） */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** 右上角操作区（自动右对齐 + 跨两行） */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

/** 正文区（仅横向内边距，纵向间距由 Card 根控制） */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

/** 底部区（带顶部分割线 + 浅色背景） */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
