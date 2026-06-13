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

  /** 每日总 Token 面积图数据 */
  const dailyChart = data?.daily.map((d) => ({
    label: formatDate(new Date(d.date), { weekday: "short" }),
    value: d.totalTokens,
  })) ?? [];

  /** 每日输出 Token 面积图数据 */
  const dailyOutputChart = data?.daily.map((d) => ({
    label: formatDate(new Date(d.date), { weekday: "short" }),
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
        <Card className="stagger-5">
          <CardHeader><CardTitle className="text-sm">{t("usage.dailyTokenUsage")}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <>
                <AreaChart data={dailyChart} color="var(--chart-1)" secondaryData={dailyOutputChart} secondaryColor="var(--chart-2)" height={180} />
                <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full" style={{ background: "var(--chart-1)" }} />
                    {t("usage.total")}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full" style={{ background: "var(--chart-2)" }} />
                    {t("usage.output")}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Agent 维度柱状图 */}
        <Card className="stagger-6">
          <CardHeader><CardTitle className="text-sm">{t("usage.byAgent")}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={(data?.byAgent ?? []).map((a, i) => ({
                  label: a.agentName, value: a.totalTokens, color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        {/* 模型维度柱状图 */}
        <Card className="stagger-7">
          <CardHeader><CardTitle className="text-sm">{t("usage.byModel")}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={(data?.byModel ?? []).map((m, i) => ({
                  label: m.model, value: m.totalTokens, color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        {/* 费用明细柱状图 */}
        <Card className="stagger-8">
          <CardHeader><CardTitle className="text-sm">{t("usage.costBreakdown")}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={(data?.daily ?? []).map((d) => ({
                  label: formatDate(new Date(d.date), { weekday: "short", month: "short", day: "numeric" }),
                  value: d.costUsd,
                  color: "var(--chart-3)",
                }))}
                formatValue={(v) => `$${v.toFixed(4)}`}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
