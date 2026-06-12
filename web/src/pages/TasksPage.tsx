
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queries, apiPost, type TaskInfo } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskCardMobile } from "@/components/tasks/task-card-mobile";
import { ListTodo, ChevronRight, XCircle, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

const STATUS_OPTIONS = ["all", "created", "dispatched", "running", "completed", "failed", "cancelled", "timeout", "resumable"] as const;
const PAGE_SIZE = 20;

export default function TasksPage() {
  const t = useT();
  const { formatDateTime } = useDateFormat();
  useDocumentTitle(t("tasks.title"));
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: agents } = useQuery(queries.agents());

  const queryParams = {
    status: statusFilter === "all" ? undefined : statusFilter,
    agent: agentFilter === "all" ? undefined : agentFilter,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading } = useQuery(queries.tasks(queryParams));
  const tasks = data?.items ?? [];
  const total = data?.total ?? 0;

  const cancelTask = useMutation({
    mutationFn: async (taskId: string) => {
      await apiPost(`/api/tasks/${taskId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(t("tasks.taskCancelled"));
    },
    onError: (err: Error) => {
      toast.error(err.message || t("tasks.failedToCancel"));
    },
  });

  const handleStatusChange = (status: string) => {
    setStatusFilter(status);
    setOffset(0);
  };

  const handleAgentChange = (agent: string) => {
    setAgentFilter(agent);
    setOffset(0);
  };

  const hasFilters = statusFilter !== "all" || agentFilter !== "all";

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">{t("tasks.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("tasks.subtitle")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
        <Select
          value={statusFilter}
          onValueChange={handleStatusChange}
          ariaLabel={t("tasks.filterByStatus")}
          options={STATUS_OPTIONS.map((s) => ({
            key: s,
            label: s === "all" ? t("tasks.allStatuses") : t(`status.${s}`) ?? s,
          }))}
          className="w-auto"
        />
        {agents && agents.length > 0 && (
          <Select
            value={agentFilter}
            onValueChange={handleAgentChange}
            ariaLabel={t("tasks.filterByAgent")}
            options={[
              { key: "all", label: t("tasks.allAgents") },
              ...agents.map((a) => ({ key: a.name, label: a.name })),
            ]}
            className="w-auto"
          />
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => { setStatusFilter("all"); setAgentFilter("all"); setOffset(0); }}
          >
            <Filter className="size-3 mr-1" />
            {t("tasks.clearFilters")}
          </Button>
        )}
        {total > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {t("tasks.ofTotal", { range: `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`, total: String(total) })}
          </span>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-border hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="w-8 px-2" />
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.id")}</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.type")}</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.agent")}</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.status")}</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.duration")}</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t("tasks.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-2"><Skeleton className="size-4" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-3 w-16" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-3 w-20" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-3 w-20" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-5 w-16 rounded-md" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-3 w-12" /></td>
                <td className="px-4 py-2.5"><Skeleton className="h-3 w-12" /></td>
              </tr>
            ))}
            {!isLoading && tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                expanded={expandedId === task.id}
                onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
                onCancel={() => cancelTask.mutate(task.id)}
              />
            ))}
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

      {/* Mobile card view */}
      <div className="mt-4 space-y-3 md:hidden">
        {isLoading && Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className={`h-16 w-full rounded-xl stagger-${Math.min(i + 1, 8)}`} />
        ))}
        {!isLoading && tasks.length === 0 && (
          <EmptyState
            icon={ListTodo}
            title={t("tasks.noTasks")}
            description={t("tasks.noTasksDesc")}
          />
        )}
        {!isLoading && tasks.map((task, i) => (
          <div key={task.id} className={`stagger-${Math.min(i + 1, 8)}`}>
            <TaskCardMobile
              task={task}
              onCancel={() => cancelTask.mutate(task.id)}
            />
          </div>
        ))}
      </div>

      {total > offset + PAGE_SIZE && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            {t("tasks.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onCancel,
}: {
  task: TaskInfo;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <>
      <tr
        className={cn(
          "border-b border-border cursor-pointer hover:bg-muted/30 active:bg-muted/40 transition-colors",
          expanded && "bg-muted/20"
        )}
        onClick={onToggle}
      >
        <td className="px-2 text-muted-foreground">
          <ChevronRight className={cn("size-4 transition-transform duration-200", expanded && "rotate-90")} />
        </td>
        <td className="px-4 py-2.5 font-mono text-xs">{task.id.slice(0, 8)}</td>
        <td className="px-4 py-2.5">{task.taskType}</td>
        <td className="px-4 py-2.5">{task.targetAgent}</td>
        <td className="px-4 py-2.5">
          <Badge
            variant={
              task.status === "completed" ? "success"
                : task.status === "failed" ? "danger"
                : task.status === "running" ? "warning"
                : "secondary"
            }
          >
            {t(`status.${task.status}`) ?? task.status}
          </Badge>
        </td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">
          {formatDuration(task.startedAt, task.finishedAt, task.status)}
        </td>
        <td className="px-4 py-2.5">
          {task.status === "running" && (
            <Button
              variant="danger"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              <XCircle className="size-3" />
              {t("tasks.cancel")}
            </Button>
          )}
        </td>
      </tr>
      <tr className={cn("border-b border-border last:border-0", !expanded && "border-0")}>
        <td colSpan={7} className="p-0">
          <div className="collapse-wrapper" data-open={expanded}>
            <div className="collapse-inner">
              <div className="bg-muted/10 px-3 md:px-6 py-3 md:py-4">
                <TaskDetail task={task} />
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

function TaskDetail({ task }: { task: TaskInfo }) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.fullId")}</span>
          <p className="mt-0.5 font-mono break-all">{task.id}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.session")}</span>
          <p className="mt-0.5 font-mono">{task.sessionId ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.created")}</span>
          <p className="mt-0.5">{fmtDT(new Date(task.createdAt))}</p>
        </div>
      </div>

      {task.status === "failed" && task.error && (
        <div>
          <span className="font-medium text-danger">{t("common.error")}</span>
          <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-danger/5 border border-danger/20 p-3 text-[11px] text-danger">
            {task.error}
          </pre>
        </div>
      )}

      {task.inputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">{t("tools.input")}</span>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-background border p-3 text-[11px]">
            {formatJson(task.inputPayload)}
          </pre>
        </div>
      )}

      {task.outputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">{t("tools.output")}</span>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-background border p-3 text-[11px]">
            {formatJson(task.outputPayload)}
          </pre>
        </div>
      )}
    </div>
  );
}

function formatDuration(startedAt?: string, finishedAt?: string, status?: string): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s${status === "running" ? "..." : ""}`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s${status === "running" ? "..." : ""}`;
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
