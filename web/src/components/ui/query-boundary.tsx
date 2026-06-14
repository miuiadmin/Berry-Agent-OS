/**
 * QueryBoundary 数据请求边界组件（泛型）。
 *
 * 统一处理 TanStack Query 的 loading / error / success 三态：
 * - loading → 渲染 skeleton
 * - error   → 渲染错误提示 + 重试按钮
 * - success → 渲染 children(data)
 *
 * 把"列表页骨架 + 错误重试"的样板代码从每个页面抽出。
 *
 * 用法：
 *   const q = useQuery(...);
 *   <QueryBoundary query={q} skeleton={<ListSkeleton />}>
 *     {(data) => <List items={data} />}
 *   </QueryBoundary>
 *
 * 结构性重构：触控目标类抽到 _shared.TOUCH_TARGET（与 EmptyState 等共用），
 * 三态分发用 early return 保持线性可读。
 */

"use client"

import type { ReactNode } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "./button"
import { cn } from "@/lib/utils"
import { TOUCH_TARGET } from "@/components/ui/_shared"
import { tOutside as t } from "@/lib/i18n"

interface QueryBoundaryProps<T> {
  /** TanStack Query 结果对象 */
  query: UseQueryResult<T>
  /** 加载态骨架（query.isLoading 或 data 为空时渲染） */
  skeleton: ReactNode
  /** 成功回调：拿到 data 渲染真正内容 */
  children: (data: T) => ReactNode
  /** 错误标题（默认 i18n queryBoundary.failedToLoad） */
  errorTitle?: string
}

export function QueryBoundary<T>({ query, skeleton, children, errorTitle }: QueryBoundaryProps<T>) {
  // 加载中：渲染骨架
  if (query.isLoading) {
    return <>{skeleton}</>
  }

  // 出错：渲染错误提示 + 重试按钮
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : t("queryBoundary.errorOccurred")
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <h3 className="mt-3 text-sm font-medium text-foreground">
          {errorTitle ?? t("queryBoundary.failedToLoad")}
        </h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{message}</p>
        <Button
          variant="outline"
          size="sm"
          // 重试按钮：移动端 44px 触控目标，桌面端 sm 紧凑
          className={cn("mt-4", TOUCH_TARGET, "md:min-h-0")}
          onClick={() => query.refetch()}
        >
          <RefreshCw className="mr-1.5 size-3" />
          {t("common.retry")}
        </Button>
      </div>
    )
  }

  // isIdle 或 data 仍为 undefined 时回退到骨架（防止渲染 undefined 子树）
  if (!query.data) {
    return <>{skeleton}</>
  }

  // 成功：渲染 children(data)
  return <div className="animate-fade-in">{children(query.data)}</div>
}
