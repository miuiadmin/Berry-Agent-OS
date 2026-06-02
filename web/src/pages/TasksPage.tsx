
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queries, apiPost, type TaskInfo } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskCardMobile } from "@/components/tasks/task-card-mobile";
import { ListTodo, ChevronRight, XCircle, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS = ["all", "created", "dispatched", "running", "completed", "failed", "cancelled", "timeout", "resumable"] as const;
const PAGE_SIZE = 20;

export default function TasksPage() {
  useDocumentTitle("Tasks");
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
      toast.success("Task cancelled");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to cancel task");
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
      <h1 className="text-lg font-semibold">Tasks</h1>
      <p className="mt-1 text-sm text-muted-foreground">Agent task history</p>

      <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
        <select
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          aria-label="Filter by status"
          className="rounded-lg border border-border bg-background px-3 py-2 md:py-1.5 text-sm min-h-[44px] md:min-h-0"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        {agents && agents.length > 0 && (
          <select
            value={agentFilter}
            onChange={(e) => handleAgentChange(e.target.value)}
            aria-label="Filter by agent"
            className="rounded-lg border border-border bg-background px-3 py-2 md:py-1.5 text-sm min-h-[44px] md:min-h-0"
          >
            <option value="all">All Agents</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => { setStatusFilter("all"); setAgentFilter("all"); setOffset(0); }}
          >
            <Filter className="size-3 mr-1" />
            Clear filters
          </Button>
        )}
        {total > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-border hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="w-8 px-2" />
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">ID</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Type</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Agent</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Duration</th>
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Actions</th>
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
                    title="No tasks found"
                    description="Tasks will appear here once agents start processing"
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
          <Skeleton key={i} className={`h-16 w-full rounded-xl stagger-${i + 1}`} />
        ))}
        {!isLoading && tasks.length === 0 && (
          <EmptyState
            icon={ListTodo}
            title="No tasks found"
            description="Tasks will appear here once agents start processing"
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
            size="default"
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Load More
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
                : task.status === "failed" ? "destructive"
                : task.status === "running" ? "warning"
                : "secondary"
            }
          >
            {task.status}
          </Badge>
        </td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">
          {formatDuration(task.startedAt, task.finishedAt, task.status)}
        </td>
        <td className="px-4 py-2.5">
          {task.status === "running" && (
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              <XCircle className="size-3" />
              Cancel
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
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <span className="font-medium text-muted-foreground">Full ID</span>
          <p className="mt-0.5 font-mono break-all">{task.id}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">Session</span>
          <p className="mt-0.5 font-mono">{task.sessionId ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">Created</span>
          <p className="mt-0.5">{new Date(task.createdAt).toLocaleString()}</p>
        </div>
      </div>

      {task.status === "failed" && task.error && (
        <div>
          <span className="font-medium text-destructive">Error</span>
          <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-destructive/5 border border-destructive/20 p-3 text-[11px] text-destructive">
            {task.error}
          </pre>
        </div>
      )}

      {task.inputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">Input</span>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-background border p-3 text-[11px]">
            {formatJson(task.inputPayload)}
          </pre>
        </div>
      )}

      {task.outputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">Output</span>
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
