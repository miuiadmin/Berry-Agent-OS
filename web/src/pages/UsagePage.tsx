
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart } from "@/components/charts/area-chart";
import { BarChart } from "@/components/charts/bar-chart";
import { Sparkline } from "@/components/charts/sparkline";
import { Coins, TrendingUp, Cpu, Bot } from "lucide-react";

export default function UsagePage() {
  useDocumentTitle("Usage");
  const { data, isLoading } = useQuery(queries.usage(7));

  const dailyChart = data?.daily.map((d) => ({
    label: new Date(d.date).toLocaleDateString([], { weekday: "short" }),
    value: d.totalTokens,
  })) ?? [];

  const dailyOutputChart = data?.daily.map((d) => ({
    label: new Date(d.date).toLocaleDateString([], { weekday: "short" }),
    value: d.outputTokens,
  })) ?? [];

  const sparkValues = data?.daily.map((d) => d.totalTokens) ?? [];

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">Token Usage</h1>
      <p className="mt-1 text-sm text-muted-foreground">7-day token consumption and cost breakdown</p>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Coins className="size-4" />
              Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-20" /> : (
              <>
                <p className="text-2xl font-bold tabular-nums">{formatTokens(data!.today.totalTokens)}</p>
                <p className="text-xs text-muted-foreground">${data!.today.costUsd.toFixed(4)} est.</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <TrendingUp className="size-4" />
              7-Day Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-20" /> : (
              <>
                <p className="text-2xl font-bold tabular-nums">{formatTokens(data!.period.totalTokens)}</p>
                <p className="text-xs text-muted-foreground">${data!.period.costUsd.toFixed(4)} est.</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Cpu className="size-4" />
              Input / Output
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-24" /> : (
              <>
                <p className="text-lg font-bold tabular-nums">
                  {formatTokens(data!.period.inputTokens)} / {formatTokens(data!.period.outputTokens)}
                </p>
                <p className="text-xs text-muted-foreground">in / out (7d)</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bot className="size-4" />
              Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-20" /> : (
              <Sparkline values={sparkValues} color="var(--chart-1)" width={120} height={32} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Daily Token Usage</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <>
                <AreaChart
                  data={dailyChart}
                  color="var(--chart-1)"
                  secondaryData={dailyOutputChart}
                  secondaryColor="var(--chart-2)"
                  height={180}
                />
                <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full" style={{ background: "var(--chart-1)" }} />
                    Total
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full" style={{ background: "var(--chart-2)" }} />
                    Output
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By Agent</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={(data!.byAgent ?? []).map((a, i) => ({
                  label: a.agentName,
                  value: a.totalTokens,
                  color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By Model</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={(data!.byModel ?? []).map((m, i) => ({
                  label: m.model,
                  value: m.totalTokens,
                  color: `var(--chart-${(i % 5) + 1})`,
                }))}
                formatValue={formatTokens}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cost Breakdown (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-40 w-full" /> : (
              <BarChart
                data={data!.daily.map((d) => ({
                  label: new Date(d.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
