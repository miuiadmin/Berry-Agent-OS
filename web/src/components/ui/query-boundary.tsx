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
 */

"use client";

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "./button";
import { tOutside as t } from "@/lib/i18n";

interface QueryBoundaryProps<T> {
  /** TanStack Query 结果对象 */
  query: UseQueryResult<T>;
  /** 加载态骨架（query.isLoading 或 data 为空时渲染） */
  skeleton: ReactNode;
  /** 成功回调：拿到 data 渲染真正内容 */
  children: (data: T) => ReactNode;
  /** 错误标题（默认 i18n queryBoundary.failedToLoad） */
  errorTitle?: string;
}

export function QueryBoundary<T>({ query, skeleton, children, errorTitle }: QueryBoundaryProps<T>) {
  if (query.isLoading) {
    return <>{skeleton}</>;
  }

  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : t("queryBoundary.errorOccurred");
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
          className="mt-4"
          onClick={() => query.refetch()}
        >
          <RefreshCw className="mr-1.5 size-3" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  // isIdle 或 data 仍为 undefined 时回退到骨架
  if (!query.data) {
    return <>{skeleton}</>;
  }

  return <div className="animate-fade-in">{children(query.data)}</div>;
}
