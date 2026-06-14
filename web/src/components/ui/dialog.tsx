/**
 * Dialog 对话框组件集（基于 Base UI 原语）。
 *
 * 普通模态弹窗：可点背景关闭、ESC 关闭、内置右上角 X 关闭按钮。
 * 与 AlertDialog 区别：Dialog 用于普通信息展示/表单，AlertDialog 用于强制确认。
 *
 * 组合用法：
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogTrigger>打开</DialogTrigger>
 *     <DialogContent>
 *       <DialogHeader>
 *         <DialogTitle>标题</DialogTitle>
 *         <DialogDescription>描述</DialogDescription>
 *       </DialogHeader>
 *       <DialogFooter>
 *         <Button>确定</Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * 移动端：max-w-[calc(100%-2rem)] 避免贴边；关闭按钮 44px 触控目标。
 *
 * 结构性重构：遮罩 / 弹层动画 / 弹层定位三类公共类与 alert-dialog 共享
 * （_shared.ts），消除两份漂移的同一段类字符串。
 */

"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { MODAL_OVERLAY, POPUP_ANIMATION, POPUP_BASE, TOUCH_TARGET } from "@/components/ui/_shared"

/** common.close i18n key 常量（DialogContent / DialogFooter 共用，避免两处各写一遍字面量） */
const CLOSE_I18N_KEY = "common.close"

/** 对话框根：受控开关 + 上下文 provider */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

/** 触发器：点击打开（render 为 button） */
function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

/** Portal：渲染到 document.body */
function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/** 关闭触发器：点击关闭对话框（可作子元素或 render 包裹） */
function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/** 半透明遮罩层：隔离背景交互 + 视觉聚焦（公共常量 MODAL_OVERLAY） */
function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(MODAL_OVERLAY, className)}
      {...props}
    />
  )
}

/**
 * 对话框主体（居中弹出 + 右上角 X 关闭按钮）。
 * @param showCloseButton 是否显示右上角关闭按钮（默认 true）
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  /** 是否显示右上角关闭按钮（默认 true） */
  showCloseButton?: boolean
}) {
  // i18n：右上角 X 按钮的 sr-only aria-label 走翻译表，避免硬编码 "Close"。
  // 与 DialogFooter 共用 CLOSE_I18N_KEY，整文件只 useT 一次取值。
  const closeLabel = useT()(CLOSE_I18N_KEY)
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // 公共定位 + 动画（与 AlertDialog 共享），宽度逻辑本组件特有
          POPUP_BASE,
          "max-w-[calc(100%-2rem)] sm:max-w-sm",
          POPUP_ANIMATION,
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label={closeLabel}
            render={
              // 移动端 44px 触控目标（TOUCH_TARGET 仅尺寸，位置类本组件独有）
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("absolute top-2 right-2", TOUCH_TARGET, "md:size-7")}
              />
            }
          >
            <XIcon className="size-5 md:size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

/** 头部容器（标题 + 描述纵向排布） */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

/**
 * 底部按钮容器。
 * @param showCloseButton 是否在末尾渲染 Close 按钮（默认 false，使用方自行放置按钮）。
 *   注意：与 DialogContent 同名但语义不同（此处是 footer 末尾的关闭按钮）。
 *   当前项目消费侧均自行在 footer 内放 Button，未启用此开关；保留以兼容未来场景。
 */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** 是否在末尾渲染 Close 按钮（默认 false） */
  showCloseButton?: boolean
}) {
  // i18n：底部 Close 按钮文案走翻译表（与 DialogContent 共用 CLOSE_I18N_KEY），
  // 仅在 showCloseButton=true 分支用，避免无谓的额外 useT 调用污染主路径。
  const closeLabel = useT()(CLOSE_I18N_KEY)
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {closeLabel}
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

/** 标题（必填，无障碍语义） */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

/** 描述文字（可选，无障碍语义） */
function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
