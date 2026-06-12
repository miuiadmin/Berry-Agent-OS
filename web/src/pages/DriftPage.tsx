import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Shield, TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** 分数进度条 — 使用 HeroUI Progress adapter 渲染，自动处理 ARIA */
function ScoreBar({ score, label }: { score: number; label: string }) {
  /** 根据分数段选择语义色：≥0.7 成功、≥0.5 警告、<0.5 危险 */
  const color = score >= 0.7 ? "success" as const : score >= 0.5 ? "warning" as const : "danger" as const;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{(score * 100).toFixed(1)}%</span>
      </div>
      <Progress value={score * 100} max={100} color={color} aria-label={label} />
    </div>
  );
}

export default function DriftPage() {
  const t = useT();
  useDocumentTitle(t("drift.title"));
  const { data, isLoading, isError, refetch } = useQuery(queries.drift(7));
  const { data: signalsData } = useQuery(queries.driftSignals());

  if (isError) {
    return (
      <div className="p-4 sm:p-6">
        <h1 className="text-lg font-semibold">{t("drift.title")}</h1>
        <EmptyState
          icon={Shield}
          title={t("drift.failedToLoad")}
          description={t("drift.unavailable")}
          action={{ label: t("common.retry"), onClick: () => refetch() }}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <h1 className="text-lg font-semibold">{t("drift.title")}</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
      </div>
    );
  }

  const metrics = data!;
  const signals = signalsData?.signals ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold">{t("drift.metricsTitle")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("drift.overview")}</p>
      </div>

      {/* 指标卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="size-4" />
              {t("drift.avgAlignment")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{(metrics.avgAlignmentScore * 100).toFixed(1)}%</div>
            <ScoreBar score={metrics.avgAlignmentScore} label={t("drift.allCheckpoints")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="size-4" />
              {t("drift.finalResponse")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{(metrics.finalResponseAlignment * 100).toFixed(1)}%</div>
            <ScoreBar score={metrics.finalResponseAlignment} label={t("drift.userFacingReplies")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="size-4" />
              {t("drift.interventionRate")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{(metrics.interventionRate * 100).toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">{t("drift.signalsTriggeredCorrection")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="size-4" />
              {t("drift.totalSignals")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{metrics.totalSignals}</div>
            <p className="text-xs text-muted-foreground mt-1">{t("drift.driftChecksIn7Days")}</p>
          </CardContent>
        </Card>
      </div>

      {/* 最近漂移事件 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t("drift.recentSignals")}</CardTitle>
        </CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("drift.noSignals")}</p>
          ) : (
            <div className="space-y-2">
              {signals.slice(0, 20).map(sig => (
                <div key={sig.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm border-b last:border-0 pb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`size-2 rounded-full shrink-0 ${sig.alignmentScore >= 0.7 ? 'bg-success' : sig.alignmentScore >= 0.5 ? 'bg-warning' : 'bg-danger'}`} />
                    <span className="text-muted-foreground shrink-0">{sig.checkpointType}</span>
                    {sig.driftDescription && (
                      <span className="text-xs truncate max-w-[120px] sm:max-w-[200px] md:max-w-[400px]">{sig.driftDescription}</span>
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
