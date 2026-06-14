/**
 * AlertDialog 组件集（基于 Base UI 原语）。
 *
 * 警告对话框 = 强制确认交互的模态弹窗：用户必须点击"确认/取消"才能关闭，
 * 不能点背景关闭（区别于普通 Dialog）。常用于"删除/不可逆操作"二次确认。
 *
 * 组合用法：
 *   <AlertDialog>
 *     <AlertDialogTrigger>...</AlertDialogTrigger>
 *     <AlertDialogContent>
 *       <AlertDialogHeader>
 *         <AlertDialogTitle>...</AlertDialogTitle>
 *         <AlertDialogDescription>...</AlertDialogDescription>
 *       </AlertDialogHeader>
 *       <AlertDialogFooter>
 *         <AlertDialogCancel>取消</AlertDialogCancel>
 *         <AlertDialogAction onClick={onDelete}>确认</AlertDialogAction>
 *       </AlertDialogFooter>
 *     </AlertDialogContent>
 *   </AlertDialog>
 *
 * size 变体：default（标题居中、按钮底部纵向）/ sm（紧凑、按钮左右双列）。
 * Media 槽位（AlertDialogMedia）可选，常放警示图标。
 *
 * 结构性重构：遮罩层 / 弹层动画 / 弹层定位三类公共类抽到 _shared.ts，
 * 与 dialog.tsx 共享同一事实源，消除两份漂移的同一段类字符串。
 */

"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { MODAL_OVERLAY, POPUP_ANIMATION, POPUP_BASE } from "@/components/ui/_shared"

/** 对话框根：受控开关 + 上下文 provider */
function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

/** 触发器：点击打开对话框（默认 render 为 button） */
function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

/** Portal：把内容渲染到 document.body，避免父级 transform/overflow 干扰 */
function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

/** 半透明遮罩层：隔离背景交互 + 视觉聚焦（公共常量 MODAL_OVERLAY） */
function AlertDialogOverlay({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(MODAL_OVERLAY, className)}
      {...props}
    />
  )
}

/**
 * 对话框主体（居中弹出）。
 * 自动包裹 Portal + Overlay，data-size 控制 default/sm 两种尺寸。
 * 公共定位（POPUP_BASE）+ 动画（POPUP_ANIMATION）来自 _shared，仅 width 逻辑本组件特有。
 */
function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  /** 尺寸变体：default（移动 max-w-xs / 桌面 sm:max-w-sm）/ sm（紧凑 max-w-xs） */
  size?: "default" | "sm"
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          POPUP_BASE,
          // 宽度：default 移动端 max-w-xs、桌面端 sm:max-w-sm；sm 始终 max-w-xs
          "max-w-xs data-[size=default]:sm:max-w-sm",
          POPUP_ANIMATION,
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

/** 头部容器：标题 + 描述（居中布局，含 media 时变三行栅格） */
function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

/** 底部按钮容器：默认纵向（移动端友好），sm 变体横向双列 */
function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

/** 可选媒体槽：警示图标 / 插画（放标题上方） */
function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className
      )}
      {...props}
    />
  )
}

/** 标题（必填，无障碍语义） */
function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "font-heading text-base font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...props}
    />
  )
}

/** 描述文字（必填，无障碍语义） */
function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * 关闭按钮（Action / Cancel 复用）：
 * 基于 AlertDialogPrimitive.Close（点击自动关闭对话框）+ render Button 渲染。
 * 消费侧 onClick 同步执行后，Close 原语自动关闭对话框。
 *
 * @param dataSlot data-slot 值（用于 CSS has-data-[slot=...] 选择器定位）
 * @param variant Button 视觉变体
 * @param size Button 尺寸变体
 */
function AlertDialogCloseButton({
  dataSlot,
  className,
  variant = "default",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size"> & {
    /** data-slot 值（用于 CSS has-data-[slot=...] 选择器定位） */
    dataSlot: string
  }) {
  return (
    <AlertDialogPrimitive.Close
      data-slot={dataSlot}
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

/** 确认按钮（默认 default variant） */
function AlertDialogAction(props: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return <AlertDialogCloseButton dataSlot="alert-dialog-action" {...props} />
}

/** 取消按钮（默认 outline variant） */
function AlertDialogCancel(props: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return <AlertDialogCloseButton dataSlot="alert-dialog-cancel" variant="outline" {...props} />
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
