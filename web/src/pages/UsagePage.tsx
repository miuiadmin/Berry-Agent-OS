/**
 * 用量统计页面。
 *
 * 展示 7 天 Token / 费用 / Agent / 模型维度的统计图表：
 * 4 张汇总卡片 + 4 张图表。
 * 共享组件：PageHeader / StatCard → ui/
 */

import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT, useDateFormat } from "@/lib/i18n";
import { AnimatedStat } from "@/components/ui/animated-stat";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { formatTokens } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart } from "@/components/charts/area-chart";
import { BarChart } from "@/components/charts/bar-chart";
import { Sparkline } from "@/components/charts/sparkline";
import { Coins, TrendingUp, Cpu, Bot } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function UsagePage() {
  const t = useT();
  const { formatDate } = useDateFormat();
  useDocumentTitle(t("usage.title"));

  const { data, isLoading, isError, refetch } = useQuery(queries.usage(7));

  // ── 错误兜底 ──
  if (isError) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={t("usage.title")} subtitle={t("usage.subtitle")} />
        <EmptyState
          icon={Coins}
          title={t("usage.failedToLoad")}
          description={t("usage.failedToLoadDesc")}
          action={{ label: t("common.retry"), onClick: () => refetch() }}
        />
      </div>
    );
  }

  // ── 图表数据（从 API 响应转换） ──

  /** 日期 → 星期缩写（多处图表共用） */
  const weekday = (d: { date: string }) =>
    formatDate(new Date(d.date), { weekday: "short" });

  /** 每日总 Token 面积图数据 */
  const dailyChart = data?.daily.map((d) => ({
    label: weekday(d),
    value: d.totalTokens,
  })) ?? [];

  /** 每日输出 Token 面积图数据 */
  const dailyOutputChart = data?.daily.map((d) => ({
    label: weekday(d),
    value: d.outputTokens,
  })) ?? [];

  /** 趋势 sparkline 数值 */
  const sparkValues = data?.daily.map((d) => d.totalTokens) ?? [];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("usage.title")} subtitle={t("usage.subtitle")} />

      {/* 汇总卡片 */}
      <div className="mt-6 grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Coins} label={t("usage.today")} stagger={1} loading={isLoading}
          value={<AnimatedStat value={data?.today.totalTokens ?? 0} format={formatTokens} />}
          desc={`$${(data?.today.costUsd ?? 0).toFixed(4)} ${t("usage.est")}`}
        />
        <StatCard
          icon={TrendingUp} label={t("usage.sevenDayTotal")} stagger={2} loading={isLoading}
          value={<AnimatedStat value={data?.period.totalTokens ?? 0} format={formatTokens} />}
          desc={`$${(data?.period.costUsd ?? 0).toFixed(4)} ${t("usage.est")}`}
        />
        <StatCard
          icon={Cpu} label={t("usage.inputOutput")} stagger={3} loading={isLoading}
          value={
            <p className="text-base sm:text-lg font-bold tabular-nums">
              <AnimatedStat value={data?.period.inputTokens ?? 0} format={formatTokens} />
              {" / "}
              <AnimatedStat value={data?.period.outputTokens ?? 0} format={formatTokens} />
            </p>
          }
          desc={t("usage.inOut7d")}
        />
        <StatCard
          icon={Bot} label={t("usage.trend")} stagger={4} loading={isLoading}
          value={<Sparkline values={sparkValues} color="var(--chart-1)" width={120} height={32} />}
        />
      </div>

      {/* 图表区域 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* 每日 Token 面积图 */}
        <ChartCard title={t("usage.dailyTokenUsage")} stagger={5} loading={isLoading}>
          <AreaChart data={dailyChart} color="var(--chart-1)" secondaryData={dailyOutputChart} secondaryColor="var(--chart-2)" height={180} />
          <ChartLegend items={[
            { color: "var(--chart-1)", label: t("usage.total") },
            { color: "var(--chart-2)", label: t("usage.output") },
          ]} />
        </ChartCard>

        {/* Agent 维度柱状图 */}
        <ChartCard title={t("usage.byAgent")} stagger={6} loading={isLoading}>
          <BarChart
            data={(data?.byAgent ?? []).map((a, i) => ({
              label: a.agentName, value: a.totalTokens, color: `var(--chart-${(i % 5) + 1})`,
            }))}
            formatValue={formatTokens}
          />
        </ChartCard>

        {/* 模型维度柱状图 */}
        <ChartCard title={t("usage.byModel")} stagger={7} loading={isLoading}>
          <BarChart
            data={(data?.byModel ?? []).map((m, i) => ({
              label: m.model, value: m.totalTokens, color: `var(--chart-${(i % 5) + 1})`,
            }))}
            formatValue={formatTokens}
          />
        </ChartCard>

        {/* 费用明细柱状图 */}
        <ChartCard title={t("usage.costBreakdown")} stagger={8} loading={isLoading}>
          <BarChart
            data={(data?.daily ?? []).map((d) => ({
              label: formatDate(new Date(d.date), { weekday: "short", month: "short", day: "numeric" }),
              value: d.costUsd,
              color: "var(--chart-3)",
            }))}
            formatValue={(v) => `$${v.toFixed(4)}`}
          />
        </ChartCard>
      </div>
    </div>
  );
}

// ─── 本页专用小组件 ─────────────────────────────────────────────────

/** 图表卡片：标题 + 加载骨架 + 图表内容（4 张图表共用骨架布局） */
function ChartCard({
  title,
  stagger,
  loading,
  children,
}: {
  title: string;
  stagger: number;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={`stagger-${stagger}`}>
      <CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-40 w-full" /> : children}
      </CardContent>
    </Card>
  );
}

/** 图表图例（色块 + 文案列表） */
function ChartLegend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
