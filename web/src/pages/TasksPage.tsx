/**
 * 任务列表页面。
 *
 * 编排任务数据的查询、筛选、分页，渲染桌面端表格 + 移动端卡片双视图。
 * 子组件：
 *   - 桌面端表格行 / 详情 → tasks-components.tsx（TaskRow / TaskDetail）
 *   - 移动端卡片 → TaskCardMobile
 * Mutations → use-task-mutations.ts
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries, type TaskInfo } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskCardMobile } from "@/components/tasks/task-card-mobile";
import { ListTodo, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { TaskRow } from "./tasks-components";
import { useTaskMutations } from "./use-task-mutations";

/** 状态筛选选项（all = 不筛选） */
const STATUS_OPTIONS = [
  "all",
  "created",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "resumable",
] as const;

/** 每页条数 */
const PAGE_SIZE = 20;

export default function TasksPage() {
  const t = useT();
  useDocumentTitle(t("tasks.title"));

  // ── 筛选 + 分页状态 ──
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  /** 桌面端当前展开的任务 ID */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── 数据查询 ──
  /** Agent 列表（用于 Agent 筛选下拉） */
  const { data: agents } = useQuery(queries.agents());

  /** 任务列表（带筛选 + 分页） */
  const queryParams = {
    status: statusFilter === "all" ? undefined : statusFilter,
    agent: agentFilter === "all" ? undefined : agentFilter,
    limit: PAGE_SIZE,
    offset,
  };
  const { data, isLoading } = useQuery(queries.tasks(queryParams));
  const tasks = data?.items ?? [];
  const total = data?.total ?? 0;

  // ── Mutations ──
  const { cancelTask } = useTaskMutations();

  // ── 筛选操作 ──
  /** 切换状态筛选，重置分页 */
  const handleStatusChange = (status: string) => {
    setStatusFilter(status);
    setOffset(0);
  };

  /** 切换 Agent 筛选，重置分页 */
  const handleAgentChange = (agent: string) => {
    setAgentFilter(agent);
    setOffset(0);
  };

  /** 是否有筛选条件激活（决定是否显示"清除筛选"按钮） */
  const hasFilters = statusFilter !== "all" || agentFilter !== "all";

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("tasks.title")} subtitle={t("tasks.subtitle")} />

      {/* 筛选栏：状态 + Agent + 清除 + 分页信息 */}
      <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
        {/* 状态下拉 */}
        <select
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          aria-label={t("tasks.filterByStatus")}
          className="rounded-lg border border-border bg-background px-3 py-2 md:py-1.5 text-sm min-h-[44px] md:min-h-0"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? t("tasks.allStatuses") : t(`status.${s}`) ?? s}
            </option>
          ))}
        </select>

        {/* Agent 下拉（有 Agent 时才显示） */}
        {agents && agents.length > 0 && (
          <select
            value={agentFilter}
            onChange={(e) => handleAgentChange(e.target.value)}
            aria-label={t("tasks.filterByAgent")}
            className="rounded-lg border border-border bg-background px-3 py-2 md:py-1.5 text-sm min-h-[44px] md:min-h-0"
          >
            <option value="all">{t("tasks.allAgents")}</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        )}

        {/* 清除筛选按钮 */}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground min-h-[44px] md:min-h-0"
            onClick={() => {
              setStatusFilter("all");
              setAgentFilter("all");
              setOffset(0);
            }}
          >
            <Filter className="size-3 mr-1" />
            {t("tasks.clearFilters")}
          </Button>
        )}

        {/* 分页信息 */}
        {total > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {t("tasks.ofTotal", {
              range: `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`,
              total: String(total),
            })}
          </span>
        )}
      </div>

      {/* 桌面端表格视图 */}
      <div className="mt-4 rounded-xl border border-border hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="w-8 px-2" />
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.id")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.type")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.agent")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.status")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.duration")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t("tasks.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {/* 加载骨架屏 */}
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-2">
                    <Skeleton className="size-4" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-3 w-16" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-3 w-20" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-3 w-20" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-5 w-16 rounded-md" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-3 w-12" />
                  </td>
                  <td className="px-4 py-2.5">
                    <Skeleton className="h-3 w-12" />
                  </td>
                </tr>
              ))}
            {/* 任务行 */}
            {!isLoading &&
              tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  expanded={expandedId === task.id}
                  onToggle={() =>
                    setExpandedId(expandedId === task.id ? null : task.id)
                  }
                  onCancel={() => cancelTask.mutate(task.id)}
                />
              ))}
            {/* 空状态 */}
            {!isLoading && tasks.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    icon={ListTodo}
                    title={t("tasks.noTasks")}
                    description={t("tasks.noTasksDesc")}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 移动端卡片视图 */}
      <div className="mt-4 space-y-3 md:hidden">
        {isLoading &&
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton
              key={i}
              className={`h-16 w-full rounded-xl stagger-${Math.min(i + 1, 8)}`}
            />
          ))}
        {!isLoading && tasks.length === 0 && (
          <EmptyState
            icon={ListTodo}
            title={t("tasks.noTasks")}
            description={t("tasks.noTasksDesc")}
          />
        )}
        {!isLoading &&
          tasks.map((task, i) => (
            <div key={task.id} className={`stagger-${Math.min(i + 1, 8)}`}>
              <TaskCardMobile
                task={task}
                onCancel={() => cancelTask.mutate(task.id)}
              />
            </div>
          ))}
      </div>

      {/* 分页：加载更多 */}
      {total > offset + PAGE_SIZE && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="default"
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            {t("tasks.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
