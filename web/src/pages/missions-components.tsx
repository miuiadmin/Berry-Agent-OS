/**
 * Missions 页面的子组件集合。
 *
 * 从 MissionsPage 拆出，让页面主文件只保留列表 + 详情的状态编排。
 * 组件间有依赖链（StatusBadge → TaskCard → MissionDetail → SquadTab → SquadCard），
 * 故集中在一个文件避免循环依赖。
 *
 * API 类型 → missions-types.ts
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { MissionTask } from "@/lib/stores/mission-store";
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
import { useT } from "@/lib/i18n";
import type {
  MissionListItemData,
  PlanResponse,
  SquadNode,
  SquadMember,
  SquadSignal,
} from "./missions-types";

// 重新导出类型，保持消费方 import 兼容
export type {
  MissionListItemData,
  MissionsListResponse,
  PlanResponse,
  SquadNode,
  SquadMember,
  SquadSignal,
} from "./missions-types";

// ─── 状态徽章 ──────────────────────────────────────────────────────

/** 任务/mission 状态 → Badge variant + 图标的映射配置 */
const STATUS_VARIANTS: Record<
  string,
  {
    variant: "default" | "secondary" | "success" | "warning" | "destructive";
    icon: React.ReactNode;
  }
> = {
  /** mission 级状态 */
  pending: { variant: "secondary", icon: <Clock className="size-3" /> },
  in_progress: {
    variant: "warning",
    icon: <Loader2 className="size-3 animate-spin" />,
  },
  completed: {
    variant: "success",
    icon: <CheckCircle2 className="size-3" />,
  },
  failed: {
    variant: "destructive",
    icon: <AlertTriangle className="size-3" />,
  },
  cancelled: { variant: "secondary", icon: <Clock className="size-3" /> },
  /** task 级状态 */
  waiting: { variant: "secondary", icon: <Clock className="size-3" /> },
  working: {
    variant: "warning",
    icon: <Loader2 className="size-3 animate-spin" />,
  },
  done: { variant: "success", icon: <CheckCircle2 className="size-3" /> },
};

/** 默认状态配置（未知状态 fallback） */
const DEFAULT_STATUS = {
  variant: "secondary" as const,
  icon: null,
};

/**
 * 状态徽章：把 mission/task 状态翻译成带图标的 Badge。
 * 优先使用 i18n key `missions.task{Status}`，不存在则直接显示原始值。
 */
export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const config = STATUS_VARIANTS[status] ?? DEFAULT_STATUS;
  /** 尝试 i18n 映射，无匹配则回退到原始状态文本 */
  const label =
    t(`missions.task${status.charAt(0).toUpperCase()}${status.slice(1)}`) ??
    status;

  return (
    <Badge variant={config.variant} className="gap-1">
      {config.icon}
      {label}
    </Badge>
  );
}

// ─── Mission 列表项 ───────────────────────────────────────────────

interface MissionListItemProps {
  /** 列表项数据 */
  mission: MissionListItemData;
  /** 是否被选中（高亮边框） */
  isSelected: boolean;
  /** 点击选中回调 */
  onClick: () => void;
}

/** mission 列表中的单个项：展示目标 / 状态 / 任务数，点击后右侧展示详情 */
export function MissionListItem({
  mission,
  isSelected,
  onClick,
}: MissionListItemProps) {
  const t = useT();

  return (
    <button
      type="button"
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
            <span>
              {t("missions.progressLabel", {
                done: String(mission.taskCount),
                total: String(mission.taskCount),
              })}
            </span>
          </div>
        </div>
        <Target className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </button>
  );
}

// ─── Mission 详情面板 ─────────────────────────────────────────────

interface MissionDetailProps {
  /** 要展示详情的 mission ID */
  missionId: string;
}

/**
 * Mission 详情：拉取 plan.json，展示目标 / 进度 / 任务列表 / squad 结构。
 * 使用 Tabs 切换 Tasks 视图与 Squad 视图。
 */
export function MissionDetail({ missionId }: MissionDetailProps) {
  const t = useT();
  const { data: plan, isLoading } = useQuery({
    queryKey: ["mission", missionId],
    queryFn: (ctx) =>
      apiGet<PlanResponse>(`/api/missions/${missionId}`, ctx.signal),
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
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("missions.failedToLoad")}
      </p>
    );
  }

  /** 已完成任务数 */
  const doneTasks = plan.tasks.filter((t) => t.status === "done").length;
  /** 总任务数 */
  const totalTasks = plan.tasks.length;
  /** 进度百分比（0–100） */
  const progressPercent =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Mission 头部：目标 + 状态 + 创建者 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{plan.mission.goal}</h3>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={plan.mission.status} />
            <span>{t("missions.createdBy", { user: plan.mission.created_by })}</span>
            <span>{new Date(plan.mission.created_at).toLocaleString()}</span>
          </div>
          {plan.mission.context && (
            <p className="mt-2 text-sm text-muted-foreground">
              {plan.mission.context}
            </p>
          )}
        </div>
        {/* 进度百分比 */}
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold">{progressPercent}%</div>
          <div className="text-xs text-muted-foreground">
            {t("missions.progressLabel", {
              done: String(doneTasks),
              total: String(totalTasks),
            })}
          </div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-success transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Tasks / Squad 切换 */}
      <Tabs value="tasks" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="tasks" className="gap-1">
            <GitBranch className="size-3" /> {t("missions.tasksTab")} (
            {totalTasks})
          </TabsTrigger>
          <TabsTrigger value="squad" className="gap-1">
            <Users className="size-3" /> {t("missions.squadTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className="space-y-2">
          {plan.tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("missions.noTasksYet")}
            </p>
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

// ─── 任务卡片 ─────────────────────────────────────────────────────

/** 单个任务卡片：状态徽章 + ID + 执行者 + 内容 + 进度/结果/依赖 */
function TaskCard({ task }: { task: MissionTask }) {
  const t = useT();

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50">
      <div className="mt-0.5 shrink-0">
        <StatusBadge status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {task.id}
          </span>
          <span className="text-xs text-muted-foreground">
            → @{task.who}
          </span>
        </div>
        <p className="mt-0.5">{task.what}</p>
        {task.progress && (
          <p className="mt-1 text-xs text-muted-foreground">
            📊 {task.progress}
          </p>
        )}
        {task.result && (
          <p className="mt-1 text-xs text-success">✅ {task.result}</p>
        )}
        {task.depends_on.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("missions.dependsLabel")}
            {task.depends_on.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Squad 面板 ───────────────────────────────────────────────────

interface SquadTabProps {
  /** mission ID（用于拉取 squad 数据） */
  missionId: string;
}

/**
 * Squad 视图：拉取 mission 的 squad 组织结构，递归渲染 {@link SquadCard}。
 * 无 squad 时显示空状态；有信号时展示最近 5 条。
 */
export function SquadTab({ missionId }: SquadTabProps) {
  const t = useT();
  const { data: squad, isLoading } = useQuery({
    queryKey: ["mission", missionId, "squad"],
    queryFn: (ctx) =>
      apiGet<{
        org?: { squads: SquadNode[] };
        signals: SquadSignal[];
      } | null>(`/api/missions/${missionId}/squad`, ctx.signal).catch(
        () => null,
      ),
  });

  if (isLoading) return <Skeleton className="h-20 w-full" />;

  if (!squad) {
    return (
      <div className="py-8 text-center">
        <EmptyState
          icon={Users}
          title={t("missions.noSquad")}
          description={t("missions.noSquadDesc")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {squad.org?.squads?.map((s: SquadNode) => (
        <SquadCard key={s.id} squad={s} depth={0} />
      ))}
      {/* 最近信号流 */}
      {squad.signals && squad.signals.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 flex items-center gap-1 text-sm font-medium">
            <Radio className="size-3" /> {t("missions.recentSignals")}
          </h4>
          {squad.signals.slice(-5).map((sig: SquadSignal, i: number) => (
            <SignalLine key={i} sig={sig} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 信号类型 → emoji 映射 */
function signalEmoji(type: string) {
  if (type === "blocker") return "🚫";
  if (type === "done") return "✅";
  if (type === "question") return "❓";
  return "📊";
}

/** 单条信号行（发送者 + 消息） */
function SignalLine({ sig }: { sig: SquadSignal }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span>{signalEmoji(sig.type)}</span>
      <span className="font-medium">{sig.from}:</span>
      <span className="text-muted-foreground">{sig.msg}</span>
    </div>
  );
}

// ─── Squad 卡片（递归） ────────────────────────────────────────────

interface SquadCardProps {
  /** 当前 squad 节点数据 */
  squad: SquadNode;
  /** 递归深度（控制缩进） */
  depth: number;
}

/** 单个 Squad 卡片：展示名称 / 目标 / 负责人 / 成员，递归渲染子 squad */
function SquadCard({ squad, depth }: SquadCardProps) {
  const t = useT();
  /** 每层缩进 16px */
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
          <p className="text-xs text-muted-foreground">
            {t("missions.goalLabel")}
            {squad.goal}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("missions.leaderLabel")}@{squad.leader}
          </p>
        </CardHeader>
        <CardContent>
          {squad.members?.map((m: SquadMember) => (
            <SquadMemberLine key={m.agent} member={m} />
          ))}
        </CardContent>
      </Card>
      {/* 递归渲染子 squad */}
      {squad.squads?.map((sub: SquadNode) => (
        <SquadCard key={sub.id} squad={sub} depth={depth + 1} />
      ))}
    </div>
  );
}

/** 成员角色 → emoji */
function roleEmoji(role: string) {
  if (role === "check") return "🔍";
  if (role === "lead") return "🧠";
  return "🔧";
}

/** 单个 squad 成员行 */
function SquadMemberLine({ member }: { member: SquadMember }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span>{roleEmoji(member.role)}</span>
      <span className="font-medium">@{member.agent}</span>
      <span className="text-muted-foreground">[{member.status}]</span>
      <span className="text-muted-foreground">{member.on}</span>
    </div>
  );
}
