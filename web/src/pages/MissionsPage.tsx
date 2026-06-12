/**
 * 13.0 多智能体协作 — Mission 管理页面。
 *
 * 展示所有 mission 的列表，点击可展开查看 plan.json 的任务状态和依赖关系。
 * 支持查看 squad 组织结构和信号流。
 */

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useMissionStore, type Mission, type MissionTask } from "@/lib/stores/mission-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Target,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  GitBranch,
  Users,
  Radio,
} from "lucide-react";

// ─── API 响应类型 ───

interface MissionsListResponse {
  items: Array<{
    id: string;
    goal: string;
    status: string;
    taskCount: number;
  }>;
  total: number;
}

interface PlanResponse {
  mission: {
    id: string;
    goal: string;
    status: string;
    created_by: string;
    created_at: string;
    context?: string;
  };
  tasks: MissionTask[];
}

// ─── 状态徽章 ───

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "success" | "warning" | "danger"; icon: React.ReactNode }> = {
    pending: { variant: "secondary", icon: <Clock className="size-3" /> },
    in_progress: { variant: "warning", icon: <Loader2 className="size-3 animate-spin" /> },
    completed: { variant: "success", icon: <CheckCircle2 className="size-3" /> },
    failed: { variant: "danger", icon: <AlertTriangle className="size-3" /> },
    cancelled: { variant: "secondary", icon: <Clock className="size-3" /> },
    // task-level statuses
    waiting: { variant: "secondary", icon: <Clock className="size-3" /> },
    working: { variant: "warning", icon: <Loader2 className="size-3 animate-spin" /> },
    done: { variant: "success", icon: <CheckCircle2 className="size-3" /> },
  };
  const config = variants[status] ?? { variant: "secondary" as const, icon: null };
  return (
    <Badge variant={config.variant} className="gap-1">
      {config.icon}
      {status}
    </Badge>
  );
}

// ─── 任务卡片 ───

function TaskCard({ task }: { task: MissionTask }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50">
      <div className="mt-0.5 shrink-0">
        <StatusBadge status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
          <span className="text-xs text-muted-foreground">→ @{task.who}</span>
        </div>
        <p className="mt-0.5">{task.what}</p>
        {task.progress && (
          <p className="mt-1 text-xs text-muted-foreground">📊 {task.progress}</p>
        )}
        {task.result && (
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">✅ {task.result}</p>
        )}
        {task.depends_on.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            depends: {task.depends_on.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Mission 详情面板 ───

function MissionDetail({ missionId }: { missionId: string }) {
  const { data: plan, isLoading } = useQuery({
    queryKey: ["mission", missionId],
    queryFn: () => apiGet<PlanResponse>(`/api/missions/${missionId}`),
  });

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!plan) {
    return <p className="p-4 text-sm text-muted-foreground">Failed to load mission details</p>;
  }

  const doneTasks = plan.tasks.filter((t) => t.status === "done").length;
  const totalTasks = plan.tasks.length;
  const progressPercent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Mission 头部 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{plan.mission.goal}</h3>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={plan.mission.status} />
            <span>by @{plan.mission.created_by}</span>
            <span>{new Date(plan.mission.created_at).toLocaleString()}</span>
          </div>
          {plan.mission.context && (
            <p className="mt-2 text-sm text-muted-foreground">{plan.mission.context}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold">{progressPercent}%</div>
          <div className="text-xs text-muted-foreground">{doneTasks}/{totalTasks} tasks</div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-green-500 transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* 任务列表 */}
      <Tabs value="tasks" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="tasks" className="gap-1">
            <GitBranch className="size-3" /> Tasks ({totalTasks})
          </TabsTrigger>
          <TabsTrigger value="squad" className="gap-1">
            <Users className="size-3" /> Squad
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className="space-y-2">
          {plan.tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet</p>
          ) : (
            plan.tasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </TabsContent>
        <TabsContent value="squad">
          <SquadTab missionId={missionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Squad 面板 ───

function SquadTab({ missionId }: { missionId: string }) {
  const { data: squad, isLoading } = useQuery({
    queryKey: ["mission", missionId, "squad"],
    queryFn: () => apiGet<any>(`/api/missions/${missionId}/squad`).catch(() => null),
  });

  if (isLoading) return <Skeleton className="h-20 w-full" />;
  if (!squad) {
    return (
      <div className="py-8 text-center">
        <EmptyState
          icon={Users}
          title="No Squad Structure"
          description="This mission uses flat task coordination without squad organization."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {squad.org?.squads?.map((s: any) => (
        <SquadCard key={s.id} squad={s} depth={0} />
      ))}
      {/* Signals */}
      {squad.signals && squad.signals.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 flex items-center gap-1 text-sm font-medium">
            <Radio className="size-3" /> Recent Signals
          </h4>
          {squad.signals.slice(-5).map((sig: any, i: number) => (
            <div key={i} className="flex items-center gap-2 py-1 text-xs">
              <span className="text-muted-foreground">{sig.type === "blocker" ? "🚫" : sig.type === "done" ? "✅" : sig.type === "question" ? "❓" : "📊"}</span>
              <span className="font-medium">{sig.from}:</span>
              <span className="text-muted-foreground">{sig.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SquadCard({ squad, depth }: { squad: any; depth: number }) {
  const indent = depth * 16;
  return (
    <div style={{ marginLeft: indent }}>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">
              {squad.name} ({squad.id})
            </CardTitle>
            <StatusBadge status={squad.status} />
          </div>
          <p className="text-xs text-muted-foreground">Goal: {squad.goal}</p>
          <p className="text-xs text-muted-foreground">Leader: @{squad.leader}</p>
        </CardHeader>
        <CardContent>
          {squad.members?.map((m: any) => (
            <div key={m.agent} className="flex items-center gap-2 py-0.5 text-xs">
              <span>{m.role === "check" ? "🔍" : m.role === "lead" ? "🧠" : "🔧"}</span>
              <span className="font-medium">@{m.agent}</span>
              <span className="text-muted-foreground">[{m.status}]</span>
              <span className="text-muted-foreground">{m.on}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {squad.squads?.map((sub: any) => (
        <SquadCard key={sub.id} squad={sub} depth={depth + 1} />
      ))}
    </div>
  );
}

// ─── Mission 列表项 ───

function MissionListItem({
  mission,
  isSelected,
  onClick,
}: {
  mission: { id: string; goal: string; status: string; taskCount: number };
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${
        isSelected ? "border-primary bg-primary/5" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{mission.goal}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={mission.status} />
            <span>{mission.taskCount} tasks</span>
          </div>
        </div>
        <Target className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </button>
  );
}

// ─── 主页面 ───

export default function MissionsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiGet<MissionsListResponse>("/api/missions"),
    refetchInterval: 10_000, // 每 10 秒刷新一次（mission 状态可能实时变化）
  });

  const missions = data?.items ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Missions</h1>
        <p className="text-sm text-muted-foreground">
          {missions.length > 0 ? `${missions.length} missions` : "No active missions"}
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-[320px_1fr]">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : missions.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No Missions Yet"
          description="Missions are created automatically when Brain detects complex multi-agent tasks. Try asking for something that requires multiple agents to collaborate."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-[320px_1fr]">
          {/* 左侧列表 */}
          <div className="space-y-2 overflow-y-auto">
            {missions.map((m) => (
              <MissionListItem
                key={m.id}
                mission={m}
                isSelected={selectedId === m.id}
                onClick={() => setSelectedId(m.id)}
              />
            ))}
          </div>

          {/* 右侧详情 */}
          <Card className="overflow-y-auto">
            <CardContent className="p-4">
              {selectedId ? (
                <MissionDetail missionId={selectedId} />
              ) : (
                <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                  Select a mission to view details
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
