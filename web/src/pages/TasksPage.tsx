/**
 * 任务列表页面。
 *
 * 编排任务数据的查询、筛选、分页，渲染桌面端表格 + 移动端卡片双视图。
 * 子组件：
 *   - 桌面端表格行 / 详情 → tasks-components.tsx（TaskRow / TaskDetail）
 *   - 移动端卡片 → TaskCardMobile
 * Mutations → use-task-mutations.ts
 */

import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { queries, TASK_STATUS_VALUES } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/components/ui/empty-state";
import { staggerClass } from "@/components/ui/_shared";
import { TaskCardMobile } from "@/components/tasks/task-card-mobile";
import { ListTodo, Filter } from "lucide-react";
import { useT } from "@/lib/i18n";
import { TaskRow } from "./tasks-components";
import { useTaskMutations } from "./use-task-mutations";

/**
 * 状态筛选选项（"all" + 后端 TaskStatus 已知值）。
 * 复用 lib/api 的 TASK_STATUS_VALUES，避免与后端枚举漂移——
 * 后端新增状态时只改 api.ts 一处，本页下拉自动跟上。
 * 注：每项都有对应的 i18n key（如 status.resumable 在 zh.ts/en.ts 已定义），
 * 缺失 key 时 t() 会回退到 key 本身，不会显示英文残留。 */
const STATUS_OPTIONS = ["all", ...TASK_STATUS_VALUES] as const;

/** 每页条数 */
const PAGE_SIZE = 20;

/** 普通数据列（非首列）的表头单元格样式 */
const TH_CLASS = "px-4 py-2.5 text-left font-medium text-muted-foreground";
/** 普通数据列（非首列）的表体单元格样式 */
const TD_CLASS = "px-4 py-2.5";

/** 桌面端表格的一列：表头文案 + 单元格样式 + 加载骨架条尺寸 */
interface TaskColumn {
  /** 表头文案（首列展开箭头为空串） */
  head: string;
  /** 表头单元格 className */
  headClass: string;
  /** 表体单元格 className */
  cellClass: string;
  /** 该列加载骨架的尺寸 className */
  skeleton: string;
}

export default function TasksPage() {
  const t = useT();
  useDocumentTitle(t("tasks.title"));

  // ── 筛选 + 分页状态 ──
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  /** 桌面端当前展开的任务 ID */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── 数据查询 ──
  /** Agent 列表（用于 Agent 筛选下拉） */
  const { data: agents } = useQuery(queries.agents());

  /**
   * 任务列表（带筛选 + 无限分页累积）。
   *
   * 用 useInfiniteQuery 而非 useQuery：queries.tasks() 的 queryFn 不做累积，
   * 单纯靠 offset 触发查询会"换页即丢前页"。useInfiniteQuery 把各页结果按
   * pages[] 数组保留，前端 concat 成完整列表，"加载更多"才名副其实。
   *
   * 筛选条件变化时整体重置（pageParam 回到 0）。
   */
  const filters = useMemo(
    () => ({
      status: statusFilter === "all" ? undefined : statusFilter,
      agent: agentFilter === "all" ? undefined : agentFilter,
    }),
    [statusFilter, agentFilter],
  );

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...queries.tasks({ ...filters, limit: PAGE_SIZE }),
    initialPageParam: 0,
    /** 根据 total + 当前累积 offset 计算下一页起点，无更多页则返回 undefined 终止 */
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + (p.items?.length ?? 0), 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  // 把多页 pages[] 展平成连续 items 列表（用于渲染）
  const tasks = useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );
  const total = data?.pages[0]?.total ?? 0;

  // ── Mutations ──
  const { cancelTask } = useTaskMutations();

  // ── 筛选操作 ──
  /** 切换状态筛选，重置分页 + 收起展开行（新筛选结果里展开的任务可能不存在） */
  const handleStatusChange = (status: string) => {
    setStatusFilter(status);
    setExpandedId(null);
  };

  /** 切换 Agent 筛选，重置分页 + 收起展开行 */
  const handleAgentChange = (agent: string) => {
    setAgentFilter(agent);
    setExpandedId(null);
  };

  /** 清除筛选：与 handleStatusChange/handleAgentChange 对齐，同步收起展开行 */
  const handleClearFilters = () => {
    setStatusFilter("all");
    setAgentFilter("all");
    setExpandedId(null);
  };

  /** 是否有筛选条件激活（决定是否显示"清除筛选"按钮） */
  const hasFilters = statusFilter !== "all" || agentFilter !== "all";

  /**
   * 桌面端表格列配置：表头与加载骨架共用同一份，新增/调整列只改这里。
   * 首列是展开箭头（窄列、空表头），其余 6 列为数据列。
   */
  const columns: TaskColumn[] = [
    { head: "", headClass: "w-8 px-2", cellClass: "px-2", skeleton: "size-4" },
    { head: t("tasks.id"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-3 w-16" },
    { head: t("tasks.type"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-3 w-20" },
    { head: t("tasks.agent"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-3 w-20" },
    { head: t("tasks.status"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-5 w-16 rounded-md" },
    { head: t("tasks.duration"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-3 w-12" },
    { head: t("tasks.actions"), headClass: TH_CLASS, cellClass: TD_CLASS, skeleton: "h-3 w-12" },
  ];

  /** 空状态：桌面表格行内与移动卡片视图共用同一份文案/图标 */
  const emptyTasks = (
    <EmptyState
      icon={ListTodo}
      title={t("tasks.noTasks")}
      description={t("tasks.noTasksDesc")}
    />
  );

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("tasks.title")} subtitle={t("tasks.subtitle")} />

      {/* 筛选栏：状态 + Agent + 清除 + 分页信息 */}
      <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
        {/* 状态下拉（w-auto 覆盖 SelectField 默认 w-full，保持筛选栏内联布局） */}
        <SelectField
          className="w-auto"
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          aria-label={t("tasks.filterByStatus")}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {/* i18n 的 t() 对缺失 key 自动回退到 key 本身，无需额外 ?? s 兜底 */}
              {s === "all" ? t("tasks.allStatuses") : t(`status.${s}`)}
            </option>
          ))}
        </SelectField>

        {/* Agent 下拉（有 Agent 时才显示） */}
        {agents && agents.length > 0 && (
          <SelectField
            className="w-auto"
            value={agentFilter}
            onChange={(e) => handleAgentChange(e.target.value)}
            aria-label={t("tasks.filterByAgent")}
          >
            <option value="all">{t("tasks.allAgents")}</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </SelectField>
        )}

        {/* 清除筛选按钮 */}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground min-h-[44px] md:min-h-0"
            onClick={handleClearFilters}
          >
            <Filter className="size-3 mr-1" />
            {t("tasks.clearFilters")}
          </Button>
        )}

        {/* 分页信息（显示当前已加载条数范围） */}
        {total > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {t("tasks.ofTotal", {
              range: `1–${Math.min(tasks.length, total)}`,
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
              {columns.map((col, i) => (
                <th key={i} className={col.headClass}>
                  {col.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 加载骨架屏（与表头共用列配置） */}
            {isLoading &&
              Array.from({ length: 5 }).map((_, row) => (
                <tr key={row} className="border-b border-border last:border-0">
                  {columns.map((col, i) => (
                    <td key={i} className={col.cellClass}>
                      <Skeleton className={col.skeleton} />
                    </td>
                  ))}
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
                <td colSpan={columns.length}>{emptyTasks}</td>
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
              className={`h-16 w-full rounded-xl ${staggerClass(i)}`}
            />
          ))}
        {!isLoading && tasks.length === 0 && emptyTasks}
        {!isLoading &&
          tasks.map((task, i) => (
            <div key={task.id} className={staggerClass(i)}>
              <TaskCardMobile
                task={task}
                onCancel={() => cancelTask.mutate(task.id)}
              />
            </div>
          ))}
      </div>

      {/* 分页：加载更多（基于 hasNextPage，加载下一页时按钮禁用 + 旋转指示） */}
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="default"
            className="min-h-[44px] md:min-h-0"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {t("tasks.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
