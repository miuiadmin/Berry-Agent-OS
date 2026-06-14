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
import { useT, useDateFormat } from "@/lib/i18n";
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

/** 把 0–1 的分数格式化为百分比字符串（保留 1 位小数） */
function pct(score: number, digits = 1) {
  return `${(score * 100).toFixed(digits)}%`;
}

export default function DriftPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("drift.title"));

  /**
   * drift 指标查询用了 withFallback（失败时返回 EMPTY_DRIFT 而非抛错），
   * 因此 isError 几乎不会为 true——metrics 加载失败会被静默降级为"满分空指标"。
   * 这里的 isError 早返回主要兜底网络层异常（非 AbortError 以外的 fetch 失败）。
   * signals 查询同样用 withFallback，但页面内显式判断 signalsError 给出
   * 红字报错（见下方三态处理）——两个查询的错误语义不完全一致是有意为之：
   * metrics 失败时全屏空指标比全屏报错更温和（用户至少看到布局），
   * signals 失败则明确告知（避免误以为"真的没有漂移"）。
   */
  const { data, isLoading, isError, refetch } = useQuery(queries.drift(7));
  // signals 单独跟踪 loading/error：之前只取 data，失败时静默显示"无信号"，
  // 用户无法区分真空 vs 加载失败。现在显式处理三态。
  const { data: signalsData, isLoading: signalsLoading, isError: signalsError } = useQuery(queries.driftSignals());

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
          {/* 骨架高度 h-32 近似 StatCard 含 ScoreBar（extra）的实际高度，
              加载→就绪减少跳动 */}
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32" />)}
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
          value={pct(metrics.avgAlignmentScore)}
          extra={<ScoreBar score={metrics.avgAlignmentScore} label={t("drift.allCheckpoints")} />}
        />
        <StatCard
          icon={CheckCircle} label={t("drift.finalResponse")}
          value={pct(metrics.finalResponseAlignment)}
          extra={<ScoreBar score={metrics.finalResponseAlignment} label={t("drift.userFacingReplies")} />}
        />
        <StatCard
          icon={AlertTriangle} label={t("drift.interventionRate")}
          value={pct(metrics.interventionRate)}
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
          {/* 三态处理：加载中骨架 / 加载失败明确报错（而非静默显示"无信号"误导）/ 数据就绪列表 */}
          {signalsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : signalsError ? (
            <p className="text-sm text-destructive">{t("drift.failedToLoad")}</p>
          ) : signals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("drift.noSignals")}</p>
          ) : (
            <div className="space-y-2">
              {/* 取前 20 条：后端 driftSignals 按时间倒序返回（最新在前），slice(0,20) 即"最近 20 条"。
                  missions-components 的 SquadTab 用 slice(-5) 取最近 5 条——那里后端按正序追加，
                  切片方向相反但语义都是"最近 N 条"。两处切片约定由各自后端排序决定，不可混用。 */}
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
                    <span className="tabular-nums font-medium">{pct(sig.alignmentScore, 0)}</span>
                    {/* 统一走 useDateFormat，与其他页面的 i18n 时区/格式一致 */}
                    <span className="text-xs text-muted-foreground">{fmtDT(new Date(sig.createdAt))}</span>
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
