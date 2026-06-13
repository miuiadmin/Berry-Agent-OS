/**
 * 用量统计页面。
 *
 * 展示 7 天 Token / 费用 / Agent / 模型维度的统计图表：
 *   - 4 张汇总卡片（今日用量 / 7 天总计 / 输入输出比 / 趋势 sparkline）
 *   - 4 张图表（每日 Token 面积图 / Agent 柱状图 / 模型柱状图 / 费用柱状图）
 */

import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT, useDateFormat } from "@/lib/i18n";
import { AnimatedStat } from "@/components/ui/animated-stat";
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
        <h1 className="text-lg font-semibold">{t("usage.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("usage.subtitle")}
        </p>
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
  const dailyChart =
    data?.daily.map((d) => ({
      label: formatDate(new Date(d.date), { weekday: "short" }),
      value: d.totalTokens,
    })) ?? [];

  /** 每日输出 Token 面积图数据（叠加在总图上） */
  const dailyOutputChart =
    data?.daily.map((d) => ({
      label: formatDate(new Date(d.date), { weekday: "short" }),
      value: d.outputTokens,
    })) ?? [];

  /** 趋势 sparkline 数值 */
  const sparkValues = data?.daily.map((d) => d.totalTokens) ?? [];

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">{t("usage.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("usage.subtitle")}</p>

      {/* 汇总卡片网格 */}
      <div className="mt-6 grid gap-4 grid-cols-2 lg:grid-cols-4">
        {/* 今日用量 */}
        <Card className="card-lift stagger-1">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Coins className="size-4" />
              {t("usage.today")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  <AnimatedStat
                    value={data?.today.totalTokens ?? 0}
                    format={formatTokens}
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  ${(data?.today.costUsd ?? 0).toFixed(4)} {t("usage.est")}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 7 天总计 */}
        <Card className="card-lift stagger-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <TrendingUp className="size-4" />
              {t("usage.sevenDayTotal")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  <AnimatedStat
                    value={data?.period.totalTokens ?? 0}
                    format={formatTokens}
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  ${(data?.period.costUsd ?? 0).toFixed(4)} {t("usage.est")}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 输入 / 输出 Token */}
        <Card className="card-lift stagger-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Cpu className="size-4" />
              {t("usage.inputOutput")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <>
                <p className="text-base sm:text-lg font-bold tabular-nums">
                  <AnimatedStat
                    value={data?.period.inputTokens ?? 0}
                    format={formatTokens}
                  />{" "}
                  /{" "}
                  <AnimatedStat
                    value={data?.period.outputTokens ?? 0}
                    format={formatTokens}
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("usage.inOut7d")}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 趋势 Sparkline */}
        <Card className="card-lift stagger-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bot className="size-4" />
              {t("usage.trend")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <Sparkline
                values={sparkValues}
                color="var(--chart-1)"
                width={120}
                height={32}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 图表区域 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* 每日 Token 用量（面积图：总量 + 输出） */}
        <Card className="stagger-5">
          <CardHeader>
            <CardTitle className="text-sm">
              {t("usage.dailyTokenUsage")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <AreaChart
                  data={dailyChart}
                  color="var(--chart-1)"
                  secondaryData={dailyOutputChart}
                  secondaryColor="var(--chart-2)"
                  height={180}
                />
                <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: "var(--chart-1)" }}
                    />
                    {t("usage.total")}
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: "var(--chart-2)" }}
                    />
                    {t("usage.output")}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Agent 维度柱状图 */}
        <Card className="stagger-6">
          <CardHeader>
            <CardTitle className="text-sm">{t("usage.byAgent")}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <BarChart
                data={(data?.byAgent ?? []).map((a, i) => ({
                  label: a.agentName,
                  value: a.totalTokens,
                  color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        {/* 模型维度柱状图 */}
        <Card className="stagger-7">
          <CardHeader>
            <CardTitle className="text-sm">{t("usage.byModel")}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <BarChart
                data={(data?.byModel ?? []).map((m, i) => ({
                  label: m.model,
                  value: m.totalTokens,
                  color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        {/* 费用明细柱状图 */}
        <Card className="stagger-8">
          <CardHeader>
            <CardTitle className="text-sm">
              {t("usage.costBreakdown")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <BarChart
                data={(data?.daily ?? []).map((d) => ({
                  label: formatDate(new Date(d.date), {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  }),
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
