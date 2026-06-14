/**
 * 首页 — 系统 Dashboard。
 *
 * 编排 5 个统计卡片 + 任务活动图 + 实时事件流 + 快捷导航。
 * 图表数据构建 / TrendIndicator / QuickLink → home-chart-data.ts
 * 共享组件：PageHeader / StatCard → ui/
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useWsStore } from "@/lib/stores/ws-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT, useDateFormat } from "@/lib/i18n";
import { AnimatedStat } from "@/components/ui/animated-stat";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { formatTokens as formatTokenCount, formatUptime } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/sparkline";
import { AreaChart } from "@/components/charts/area-chart";
import { EmptyState } from "@/components/ui/empty-state";
import { buildChartData, TrendIndicator, QuickLink } from "./home-chart-data";
import {
  Activity, Bot, ListTodo, MessageCircle, Zap,
  CheckCircle, XCircle, Coins,
} from "lucide-react";

/** 实时活动事件的类型 */
interface ActivityEvent {
  event: string;
  ts: number;
  payload: Record<string, unknown>;
}

/** 事件前缀 → 图标 */
const EVENT_ICONS: Record<string, typeof Activity> = {
  "task.": ListTodo,
  "agent.": Bot,
};

/** 事件关键词 → 语义颜色 */
function eventColor(event: string) {
  if (event.includes("failed") || event.includes("crashed")) return "text-destructive";
  if (event.includes("completed") || event.includes("enabled")) return "text-success";
  if (event.includes("running") || event.includes("started")) return "text-warning";
  return "text-muted-foreground";
}

export default function HomePage() {
  const t = useT();
  const { formatDate, formatTime } = useDateFormat();
  useDocumentTitle(t("sidebar.home"));

  // ── 数据查询 ──
  const { data: health, isLoading: healthLoading } = useQuery(queries.health());
  const { data: agents, isLoading: agentsLoading } = useQuery(queries.agents());
  const { data: runningData } = useQuery(queries.tasks({ status: "running", limit: 1 }));
  const { data: completedData } = useQuery(queries.tasks({ status: "completed", limit: 100 }));
  const { data: failedData } = useQuery(queries.tasks({ status: "failed", limit: 100 }));
  const { data: statsData } = useQuery(queries.taskStats(7));
  const { data: usageData } = useQuery(queries.usage(7));

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const subscribe = useWsStore((s) => s.subscribe);

  // 订阅全局 WS 事件，保留最近 15 条
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
    () => buildChartData(statsData, completedData?.items ?? [], failedData?.items ?? [], formatDate),
    [statsData, completedData, failedData, formatDate],
  );

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("home.title")} subtitle={t("home.subtitle")} />

      {/* 统计卡片网格 */}
      <div className="mt-6 grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={Activity} label={t("home.system")} stagger={1}
          loading={healthLoading}
          value={health?.ok ? t("home.healthy") : t("home.down")}
          desc={`${t("home.uptime")}: ${health ? formatUptime(health.uptime) : "—"}`}
        />
        <StatCard
          icon={Bot} label={t("home.agents")} stagger={2}
          loading={agentsLoading}
          value={<><AnimatedStat value={activeAgents} />/<AnimatedStat value={totalAgents} /></>}
          desc={t("home.activeTotal")}
        />
        <StatCard
          icon={Zap} label={t("home.running")} stagger={3}
          value={<AnimatedStat value={runningData?.total ?? 0} />}
          desc={t("home.tasksInProgress")}
        />
        <StatCard
          icon={ListTodo} label={t("home.tasks")} stagger={4}
          value={
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
          }
          extra={
            <div className="mt-2 flex items-center gap-2">
              <Sparkline values={chartData.sparkCompleted} color="var(--success)" width={60} height={20} />
              <TrendIndicator
                current={chartData.sparkCompleted[chartData.sparkCompleted.length - 1] ?? 0}
                previous={chartData.sparkCompleted[chartData.sparkCompleted.length - 2] ?? 0}
              />
            </div>
          }
        />
        <StatCard
          icon={Coins} label={t("home.tokens")} stagger={5}
          value={
            <AnimatedStat value={usageData?.today.totalTokens ?? 0} format={formatTokenCount} />
          }
          desc={`${t("home.today")} ($${(usageData?.today.costUsd ?? 0).toFixed(3)})`}
          extra={usageData && usageData.daily.length > 1 && (
            <div className="mt-2">
              <Sparkline values={usageData.daily.map((d) => d.totalTokens)} color="var(--chart-1)" width={60} height={20} />
            </div>
          )}
        />
      </div>

      {/* 底部双栏：任务活动图 + 实时事件 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="stagger-6">
          <CardHeader>
            <CardTitle className="text-sm">{t("home.taskActivity")}</CardTitle>
          </CardHeader>
          <CardContent>
            <AreaChart
              data={chartData.completed} color="var(--success)"
              secondaryData={chartData.failed} secondaryColor="var(--destructive)"
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
            <Link to="/tasks" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {t("home.viewAll")}
            </Link>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <EmptyState icon={Activity} title={t("home.listening")} description={t("home.activityHint")} />
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {events.map((ev) => {
                  const Icon = EVENT_ICONS[Object.keys(EVENT_ICONS).find((p) => ev.event.startsWith(p)) ?? ""] ?? Activity;
                  return (
                    <div key={ev.ts} className="flex items-center gap-2 text-xs min-w-0 animate-slide-left">
                      <Icon className={`size-3.5 shrink-0 ${eventColor(ev.event)}`} />
                      <span className="text-muted-foreground shrink-0">
                        {formatTime(new Date(ev.ts), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className="font-medium truncate">{t(`status.${ev.event.split(".").pop()}`) ?? ev.event}</span>
                      {typeof ev.payload.name === "string" && (
                        <span className="text-muted-foreground truncate">{ev.payload.name}</span>
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
