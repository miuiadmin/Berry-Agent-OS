
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { queries } from "@/lib/api";
import { useWsStore } from "@/lib/stores/ws-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT, useDateFormat } from "@/lib/i18n";
import { useCountUp } from "@/hooks/use-count-up";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/charts/sparkline";
import { AreaChart } from "@/components/charts/area-chart";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Activity,
  Bot,
  ListTodo,
  MessageCircle,
  Zap,
  CheckCircle,
  XCircle,
  Coins,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

interface ActivityEvent {
  event: string;
  ts: number;
  payload: Record<string, unknown>;
}

function getEventIcon(event: string) {
  if (event.startsWith("task.")) return ListTodo;
  if (event.startsWith("agent.")) return Bot;
  return Activity;
}

function getEventColor(event: string) {
  if (event.includes("failed") || event.includes("crashed")) return "text-destructive";
  if (event.includes("completed") || event.includes("enabled")) return "text-success";
  if (event.includes("running") || event.includes("started")) return "text-warning";
  return "text-muted-foreground";
}

function TrendIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return <Minus className="size-3 text-muted-foreground" />;
  if (current > previous) return <TrendingUp className="size-3 text-success" />;
  if (current < previous) return <TrendingDown className="size-3 text-destructive" />;
  return <Minus className="size-3 text-muted-foreground" />;
}

/** Animated stat number — counts up from 0 on mount */
function AnimatedStat({ value, format }: { value: number; format?: (n: number) => string }) {
  const animated = useCountUp(value);
  const display = format ? format(animated) : String(animated);
  return <span className="tabular-nums">{display}</span>;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function HomePage() {
  const t = useT();
  const { formatDate, formatTime, formatNumber } = useDateFormat();
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

  const chartData = useMemo(() => {
    // Prefer stats API data if available
    if (statsData && statsData.length > 0) {
      const completedByDay = statsData.map((d) => d.completed);
      const failedByDay = statsData.map((d) => d.failed);
      const labels = statsData.map((d) => {
        const date = new Date(d.date);
        return formatDate(date, { weekday: "short" });
      });
      return {
        completed: labels.map((label, i) => ({ label, value: completedByDay[i] })),
        failed: labels.map((label, i) => ({ label, value: failedByDay[i] })),
        sparkCompleted: completedByDay,
        sparkFailed: failedByDay,
      };
    }

    // Fallback: client-side aggregation from task lists
    const completedTasks = completedData?.items ?? [];
    const failedTasks = failedData?.items ?? [];

    const days = 7;
    const now = new Date();
    const labels: string[] = [];
    const completedByDay: number[] = [];
    const failedByDay: number[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dayStr = formatDate(date, { weekday: "short" });
      labels.push(dayStr);

      const dateStart = new Date(date.setHours(0, 0, 0, 0)).getTime();
      const dateEnd = dateStart + 86400000;

      completedByDay.push(
        completedTasks.filter((t) => {
          const ts = new Date(t.finishedAt ?? t.createdAt).getTime();
          return ts >= dateStart && ts < dateEnd;
        }).length,
      );
      failedByDay.push(
        failedTasks.filter((t) => {
          const ts = new Date(t.finishedAt ?? t.createdAt).getTime();
          return ts >= dateStart && ts < dateEnd;
        }).length,
      );
    }

    return {
      completed: labels.map((label, i) => ({ label, value: completedByDay[i] })),
      failed: labels.map((label, i) => ({ label, value: failedByDay[i] })),
      sparkCompleted: completedByDay,
      sparkFailed: failedByDay,
    };
  }, [statsData, completedData, failedData]);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("home.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("home.subtitle")}</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="mt-6 grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {/* Health */}
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

        {/* Agents */}
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

        {/* Running Tasks */}
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

        {/* Task Totals */}
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

        {/* Token Usage */}
        <Card className="card-lift stagger-5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Coins className="size-4" />
              <Link to="/usage" className="hover:text-foreground transition-colors">{t("home.tokens")}</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">
              <AnimatedStat value={usageData?.today.totalTokens ?? 0} format={formatTokenCount} />
            </p>
            <p className="text-xs text-muted-foreground">
              {t("home.today")} (${(usageData?.today.costUsd ?? 0).toFixed(3)})
            </p>
            {usageData && usageData.daily.length > 1 && (
              <div className="mt-2">
                <Sparkline values={usageData.daily.map((d) => d.totalTokens)} color="var(--chart-1)" width={60} height={20} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom Section */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Task Activity Chart */}
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

        {/* Recent Activity */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">{t("home.recentActivity")}</CardTitle>
            <Link to="/tasks" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {t("home.viewAll")}
            </Link>
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
                {events.map((ev, i) => {
                  const Icon = getEventIcon(ev.event);
                  const colorClass = getEventColor(ev.event);
                  return (
                    <div key={`${ev.ts}-${i}`} className={cn("flex items-center gap-2 text-xs min-w-0 animate-slide-left")}>
                      <Icon className={`size-3.5 shrink-0 ${colorClass}`} />
                      <span className="text-muted-foreground shrink-0">
                        {formatTime(new Date(ev.ts), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className="font-medium truncate">{ev.event}</span>
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

      {/* Quick Navigation */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickLink href="/chat" icon={MessageCircle} label={t("home.quickChat")} />
        <QuickLink href="/agents" icon={Bot} label={t("home.agents")} />
        <QuickLink href="/tasks" icon={ListTodo} label={t("home.tasks")} />
        <QuickLink href="/conversations" icon={Activity} label={t("home.quickHistory")} />
      </div>
    </div>
  );
}

function QuickLink({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link
      to={href}
      className="group flex items-center gap-2 rounded-lg border px-3 py-3 md:py-2.5 text-sm card-lift hover:border-ring/30 active:scale-[0.97] transition-all duration-200"
    >
      <Icon className="size-4 text-muted-foreground transition-transform duration-200 group-hover:scale-110" />
      {label}
    </Link>
  );
}

function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
