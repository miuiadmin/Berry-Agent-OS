/**
 * EmptyState 空状态组件。
 *
 * 列表 / 卡片为空时的统一占位：图标 + 标题 + 描述 + 可选行动按钮。
 * 常用于"暂无数据"、"无搜索结果"等场景。
 *
 * 用法：
 *   <EmptyState icon={Inbox} title={t("common.empty")} />
 *   <EmptyState icon={Bot} title="暂无 Agent" description="点击下方按钮创建"
 *     action={{ label: "创建", onClick: handleCreate }} />
 *
 * 结构性重构：把行动按钮的"移动端 44px / 桌面端紧凑"尺寸类抽到常量，
 * 与 QueryBoundary 的重试按钮共用同一组类（避免两处漂移）。
 */

"use client"

import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { TOUCH_TARGET } from "@/components/ui/_shared"

interface EmptyStateProps {
  /** 顶部图标 */
  icon: LucideIcon
  /** 主标题（前景色） */
  title: string
  /** 副描述（muted 灰色，可选） */
  description?: string
  /** 行动按钮（可选） */
  action?: {
    label: string
    onClick: () => void
  }
  /** 容器额外 className */
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center animate-fade-in", className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-muted animate-pulse-dot">
        <Icon className="size-6 text-muted-foreground/60" />
      </div>
      <h3 className="mt-3 text-sm font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{description}</p>
      )}
      {/* 行动按钮：移动端 44px 触控目标（TOUCH_TARGET），桌面端 md:h-9 紧凑 */}
      {action && (
        <Button variant="outline" size="default" className={cn("mt-4", TOUCH_TARGET, "md:h-9")} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
