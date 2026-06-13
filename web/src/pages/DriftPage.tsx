/**
 * 漂移检测（Drift）指标页面。
 *
 * 展示 7 天内的对齐度指标（平均对齐 / 最终回复对齐 / 干预率 / 信号总数）
 * 和最近漂移事件列表。
 * 共享组件：PageHeader / StatCard → ui/
 */

import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** 对齐分数 → 进度条颜色 class */
function scoreColor(score: number) {
  return score >= 0.7 ? "bg-success" : score >= 0.5 ? "bg-warning" : "bg-destructive";
}

export default function DriftPage() {
  const t = useT();
  useDocumentTitle(t("drift.title"));

  const { data, isLoading, isError, refetch } = useQuery(queries.drift(7));
  const { data: signalsData } = useQuery(queries.driftSignals());

  // ── 错误兜底 ──
  if (isError) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={t("drift.title")} />
        <EmptyState
          icon={Shield}
          title={t("drift.failedToLoad")}
          description={t("drift.unavailable")}
          action={{ label: t("common.retry"), onClick: () => refetch() }}
        />
      </div>
    );
  }

  // ── 加载态 ──
  if (isLoading || !data) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <PageHeader title={t("drift.title")} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      </div>
    );
  }

  // ── 数据就绪 ──
  const metrics = data;
  const signals = signalsData?.signals ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <PageHeader title={t("drift.metricsTitle")} subtitle={t("drift.overview")} />

      {/* 指标卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={TrendingUp} label={t("drift.avgAlignment")}
          value={`${(metrics.avgAlignmentScore * 100).toFixed(1)}%`}
          extra={<ScoreBar score={metrics.avgAlignmentScore} label={t("drift.allCheckpoints")} />}
        />
        <StatCard
          icon={CheckCircle} label={t("drift.finalResponse")}
          value={`${(metrics.finalResponseAlignment * 100).toFixed(1)}%`}
          extra={<ScoreBar score={metrics.finalResponseAlignment} label={t("drift.userFacingReplies")} />}
        />
        <StatCard
          icon={AlertTriangle} label={t("drift.interventionRate")}
          value={`${(metrics.interventionRate * 100).toFixed(1)}%`}
          desc={t("drift.signalsTriggeredCorrection")}
        />
        <StatCard
          icon={Shield} label={t("drift.totalSignals")}
          value={metrics.totalSignals}
          desc={t("drift.driftChecksIn7Days")}
        />
      </div>

      {/* 最近漂移事件 */}
      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">{t("drift.recentSignals")}</CardTitle></CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("drift.noSignals")}</p>
          ) : (
            <div className="space-y-2">
              {signals.slice(0, 20).map((sig) => (
                <div
                  key={sig.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm border-b last:border-0 pb-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`size-2 shrink-0 rounded-full ${scoreColor(sig.alignmentScore)}`} />
                    <span className="text-muted-foreground shrink-0">{sig.checkpointType}</span>
                    {sig.driftDescription && (
                      <span className="text-xs truncate max-w-[120px] sm:max-w-[200px] md:max-w-[400px]">
                        {sig.driftDescription}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 pl-4 sm:pl-0">
                    <span className="tabular-nums font-medium">{(sig.alignmentScore * 100).toFixed(0)}%</span>
                    <span className="text-xs text-muted-foreground">{new Date(sig.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── 分数进度条（仅本页面使用） ────────────────────────────────────

/** 对齐分数进度条 */
function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{(score * 100).toFixed(1)}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${scoreColor(score)} transition-all`} style={{ width: `${score * 100}%` }} />
      </div>
    </div>
  );
}
