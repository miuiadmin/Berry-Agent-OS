/**
 * 首页 — 系统 Dashboard。
 *
 * 编排 5 个统计卡片 + 任务活动图 + 实时事件流 + 快捷导航。
 * 图表数据构建 / TrendIndicator / QuickLink → home-chart-data.ts
 * 格式化工具 → lib/format.ts
 * AnimatedStat → ui/animated-stat.tsx
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useWsStore } from "@/lib/stores/ws-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT, useDateFormat } from "@/lib/i18n";
import { AnimatedStat } from "@/components/ui/animated-stat";
import { formatTokens as formatTokenCount, formatUptime } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/charts/sparkline";
import { AreaChart } from "@/components/charts/area-chart";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { buildChartData, TrendIndicator, QuickLink } from "./home-chart-data";
import {
  Activity,
  Bot,
  ListTodo,
  MessageCircle,
  Zap,
  CheckCircle,
  XCircle,
  Coins,
} from "lucide-react";

/** 实时活动事件的类型 */
interface ActivityEvent {
  event: string;
  ts: number;
  payload: Record<string, unknown>;
}

/** 根据事件前缀返回对应图标 */
function getEventIcon(event: string) {
  if (event.startsWith("task.")) return ListTodo;
  if (event.startsWith("agent.")) return Bot;
  return Activity;
}

/** 根据事件关键词返回语义颜色 class */
function getEventColor(event: string) {
  if (event.includes("failed") || event.includes("crashed")) return "text-destructive";
  if (event.includes("completed") || event.includes("enabled")) return "text-success";
  if (event.includes("running") || event.includes("started")) return "text-warning";
  return "text-muted-foreground";
}

export default function HomePage() {
  const t = useT();
  const { formatDate, formatTime } = useDateFormat();
  useDocumentTitle(t("sidebar.home"));
  const { data: health, isLoading: healthLoading } = useQuery(queries.health());
  const { data: agents, isLoading: agentsLoading } = useQuery(queries.agents());
  const { data: runningData } = useQuery(queries.tasks({ status: "running", limit: 1 }));
  const { data: completedData } = useQuery(queries.tasks({ status: "completed", limit: 100 }));
  const { data: failedData } = useQuery(queries.tasks({ status: "failed", limit: 100 }));
  const { data: statsData } = useQuery(queries.taskStats(7));
  const { data: usageData } = useQuery(queries.usage(7));

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const subscribe = useWsStore((s) => s.subscribe);

  // 订阅全局 WebSocket 事件，保留最近 15 条用于实时活动展示
  useEffect(() => {
    const unsub = subscribe("*", (raw) => {
      const data = raw as { event?: string; payload?: Record<string, unknown>; ts?: number };
      if (data.event) {
        setEvents((prev) => [
          { event: data.event!, ts: data.ts ?? Date.now(), payload: data.payload ?? {} },
          ...prev,
        ].slice(0, 15));
      }
    });
    return unsub;
  }, [subscribe]);

  const activeAgents = agents?.filter((a) => a.status === "enabled").length ?? 0;
  const totalAgents = agents?.length ?? 0;

  const chartData = useMemo(
    () =>
      buildChartData(
        statsData,
        completedData?.items ?? [],
        failedData?.items ?? [],
        formatDate,
      ),
    [statsData, completedData, failedData, formatDate],
  );

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("home.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("home.subtitle")}</p>
        </div>
      </div>

      {/* 统计卡片网格 */}
      <div className="mt-6 grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {/* 系统健康 */}
        <Card className="card-lift stagger-1">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Activity className="size-4" />
              {t("home.system")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold">
                  {health?.ok ? t("home.healthy") : t("home.down")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("home.uptime")}: {health ? formatUptime(health.uptime) : "—"}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Agent 数量 */}
        <Card className="card-lift stagger-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bot className="size-4" />
              {t("home.agents")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agentsLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <>
                <p className="text-2xl font-bold">
                  <AnimatedStat value={activeAgents} />/<AnimatedStat value={totalAgents} />
                </p>
                <p className="text-xs text-muted-foreground">{t("home.activeTotal")}</p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 运行中任务 */}
        <Card className="card-lift stagger-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="size-4" />
              {t("home.running")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              <AnimatedStat value={runningData?.total ?? 0} />
            </p>
            <p className="text-xs text-muted-foreground">{t("home.tasksInProgress")}</p>
          </CardContent>
        </Card>

        {/* 任务总计（完成/失败 + 趋势 sparkline） */}
        <Card className="card-lift stagger-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ListTodo className="size-4" />
              {t("home.tasks")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <CheckCircle className="size-3 text-success" />
                <span className="text-sm font-medium"><AnimatedStat value={completedData?.total ?? 0} /></span>
              </div>
              <div className="flex items-center gap-1">
                <XCircle className="size-3 text-destructive" />
                <span className="text-sm font-medium"><AnimatedStat value={failedData?.total ?? 0} /></span>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Sparkline values={chartData.sparkCompleted} color="var(--success)" width={60} height={20} />
              <TrendIndicator
                current={chartData.sparkCompleted[chartData.sparkCompleted.length - 1] ?? 0}
                previous={chartData.sparkCompleted[chartData.sparkCompleted.length - 2] ?? 0}
              />
            </div>
          </CardContent>
        </Card>

        {/* Token 用量 */}
        <Card className="card-lift stagger-5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Coins className="size-4" />
              <a href="/settings?tab=providers" className="hover:text-foreground transition-colors">{t("home.tokens")}</a>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">
              <AnimatedStat value={usageData?.today.totalTokens ?? 0} format={formatTokenCount} />
            </p>
            <p className="text-xs text-muted-foreground">
              {t("home.today")} (${(usageData?.today.costUsd ?? 0).toFixed(3)})
            </p>
            {usageData && usageData?.daily?.length > 1 && (
              <div className="mt-2">
                <Sparkline values={usageData.daily?.map((d) => d.totalTokens) ?? []} color="var(--chart-1)" width={60} height={20} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 底部双栏：任务活动图 + 实时事件 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="stagger-6">
          <CardHeader>
            <CardTitle className="text-sm">{t("home.taskActivity")}</CardTitle>
          </CardHeader>
          <CardContent>
            <AreaChart
              data={chartData.completed}
              color="var(--success)"
              secondaryData={chartData.failed}
              secondaryColor="var(--destructive)"
              height={160}
            />
            <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block size-2 rounded-full bg-success" />
                {t("home.completed")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block size-2 rounded-full bg-destructive" />
                {t("home.failed")}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">{t("home.recentActivity")}</CardTitle>
            <a href="/tasks" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {t("home.viewAll")}
            </a>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <EmptyState
                icon={Activity}
                title={t("home.listening")}
                description={t("home.activityHint")}
              />
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {events.map((ev) => {
                  const Icon = getEventIcon(ev.event);
                  const colorClass = getEventColor(ev.event);
                  return (
                    <div key={ev.ts} className={cn("flex items-center gap-2 text-xs min-w-0 animate-slide-left")}>
                      <Icon className={`size-3.5 shrink-0 ${colorClass}`} />
                      <span className="text-muted-foreground shrink-0">
                        {formatTime(new Date(ev.ts), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className="font-medium truncate">{t(`status.${ev.event.split('.').pop()}`) ?? ev.event}</span>
                      {typeof ev.payload.name === "string" && (
                        <span className="text-muted-foreground truncate">
                          {ev.payload.name}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 快捷导航 */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickLink href="/chat" icon={MessageCircle} label={t("home.quickChat")} />
        <QuickLink href="/agents" icon={Bot} label={t("home.agents")} />
        <QuickLink href="/tasks" icon={ListTodo} label={t("home.tasks")} />
        <QuickLink href="/conversations" icon={Activity} label={t("home.quickHistory")} />
      </div>
    </div>
  );
}
