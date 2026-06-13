/**
 * Scheduler（定时任务）管理页面。
 *
 * 编排三组 tab 数据（Jobs / Queue / Webhooks）+ mutations（创建/删除/暂停/恢复/触发），
 * 渲染细节下放到子组件：
 *   - {@link JobCard} / {@link JobExecutions} / {@link CreateJobCard} → scheduler-components.tsx
 *   - useSchedulerMutations → use-scheduler-mutations.ts
 * 共享组件：PageHeader / StatCard / TextAreaField → ui/
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Plus, Webhook } from "lucide-react";
import { schedulerApi, type SchedulerQueue } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CardListSkeleton } from "@/components/ui/card-list-skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import { JobCard, CreateJobCard, type JobCardActions } from "./scheduler-components";
import { useSchedulerMutations } from "./use-scheduler-mutations";

/** Tab 配置（key + 对应的 i18n label key） */
const TAB_CONFIG = [
  { key: "jobs", labelKey: "scheduler.title" },
  { key: "queue", labelKey: "scheduler.running" },
  { key: "webhooks", labelKey: "scheduler.webhooks" },
] as const;

type TabKey = (typeof TAB_CONFIG)[number]["key"];

export default function SchedulerPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("scheduler.title"));

  // ── 页面状态 ──
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<TabKey>("jobs");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── 数据查询 ──
  const jobsQuery = useQuery({ queryKey: ["scheduler-jobs"], queryFn: () => schedulerApi.listJobs() });
  const queueQuery = useQuery({ queryKey: ["scheduler-queue"], queryFn: () => schedulerApi.queue() });
  const webhookQuery = useQuery({
    queryKey: ["scheduler-webhooks"],
    queryFn: () => schedulerApi.webhookAudit({ limit: 50 }),
    enabled: tab === "webhooks",
  });

  const jobs = jobsQuery.data ?? [];
  const queue: SchedulerQueue | null = queueQuery.data ?? null;

  // ── Mutations ──
  const { createMut, deleteMut, pauseMut, resumeMut, triggerMut } = useSchedulerMutations();

  /** 传给 JobCard 的操作回调（统一 pending 状态） */
  const jobActions: JobCardActions = {
    onPause: (id) => pauseMut.mutate(id),
    onResume: (id) => resumeMut.mutate(id),
    onTrigger: (id) => triggerMut.mutate(id),
    onDelete: (id) => setDeleteTarget(id),
    pausing: pauseMut.isPending,
    resuming: resumeMut.isPending,
    triggering: triggerMut.isPending,
  };

  /** Tab 键盘导航（左右箭头） */
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const len = TAB_CONFIG.length;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setTab(TAB_CONFIG[(idx + 1) % len].key);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setTab(TAB_CONFIG[(idx - 1 + len) % len].key);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title={t("scheduler.title")} subtitle={t("scheduler.subtitle")} icon={Clock} iconClass="text-brand">
        <Button onClick={() => setShowCreate(!showCreate)} size="sm" className="h-11 md:h-9">
          <Plus className="mr-1 size-4" />
          {t("scheduler.newJob")}
        </Button>
      </PageHeader>

      {/* 队列状态迷你栏 */}
      {queue && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>{t("scheduler.queueRunning", { count: String(queue.running) })}</span>
          <span>{t("scheduler.queuePending", { count: String(queue.pending) })}</span>
          <span>{t("scheduler.queueMaxConcurrency", { count: String(queue.maxConcurrency) })}</span>
        </div>
      )}

      {/* Tab 切换器 */}
      <div className="flex gap-1 border-b" role="tablist" aria-label={t("scheduler.title")}>
        {TAB_CONFIG.map((tabItem, idx) => (
          <button
            type="button"
            key={tabItem.key}
            role="tab"
            aria-selected={tab === tabItem.key}
            onClick={() => setTab(tabItem.key)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className={cn(
              "min-h-[44px] px-3 py-2 text-sm font-medium capitalize transition-colors md:min-h-0",
              tab === tabItem.key
                ? "border-b-2 border-brand text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      {/* 新建 Job 表单 */}
      {showCreate && tab === "jobs" && (
        <CreateJobCard onClose={() => setShowCreate(false)} onCreate={(data) => createMut.mutate(data)} />
      )}

      {/* Jobs tab */}
      {tab === "jobs" && (
        <div role="tabpanel">
          <QueryBoundary query={jobsQuery} skeleton={<CardListSkeleton count={2} bars={["h-4 w-1/3", "h-3 w-2/3"]} />}>
            {(jobs) =>
              jobs.length === 0 ? (
                <EmptyState
                  icon={Clock} title={t("scheduler.noJobs")} description={t("scheduler.noJobsDesc")}
                  action={{ label: t("scheduler.newJob"), onClick: () => setShowCreate(true) }}
                />
              ) : (
                <div className="space-y-2">
                  {jobs.map((job) => <JobCard key={job.id} job={job} actions={jobActions} />)}
                </div>
              )
            }
          </QueryBoundary>
        </div>
      )}

      {/* Queue tab */}
      {tab === "queue" && (
        <div role="tabpanel">
          <QueryBoundary query={queueQuery} skeleton={<QueueSkeleton />}>
            {(q) => q ? (
              <div className="grid gap-4 md:grid-cols-3">
                <StatCard icon={Clock} label={t("scheduler.running")} value={q.running} />
                <StatCard icon={Clock} label={t("scheduler.pending")} value={q.pending} />
                <StatCard icon={Clock} label={t("scheduler.maxConcurrency")} value={q.maxConcurrency} />
              </div>
            ) : (
              <EmptyState icon={Clock} title={t("scheduler.queueStatusUnavailable")} description={t("scheduler.queueStatusUnavailableDesc")} />
            )}
          </QueryBoundary>
        </div>
      )}

      {/* Webhooks tab */}
      {tab === "webhooks" && (
        <div role="tabpanel">
          <QueryBoundary query={webhookQuery} skeleton={<CardListSkeleton count={3} bars={["h-4 w-1/3"]} />}>
            {(webhooks) => webhooks.length === 0 ? (
              <EmptyState icon={Webhook} title={t("scheduler.noWebhookDeliveries")} description={t("scheduler.webhookHint")} />
            ) : (
              <div className="space-y-2">
                {webhooks.map((entry) => (
                  <Card key={entry.id}>
                    <CardContent className="py-3">
                      <div className="flex items-center gap-2 text-sm">
                        <Badge variant="outline" className="text-[11px] font-mono">
                          {entry.token.slice(0, 8)}…
                        </Badge>
                        <span className="text-muted-foreground">{entry.result}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground/70">
                          {fmtDT(new Date(entry.createdAt))}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </QueryBoundary>
        </div>
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("scheduler.deleteJobConfirm", { name: t("scheduler.job") })}
        description={t("scheduler.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) { deleteMut.mutate(deleteTarget); setDeleteTarget(null); }
        }}
      />
    </div>
  );
}

// ─── Skeleton 组件 ─────────────────────────────────────────────────

function QueueSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}><CardContent className="py-4 text-center">
          <div className="mx-auto h-8 w-16 animate-pulse rounded bg-muted" />
        </CardContent></Card>
      ))}
    </div>
  );
}
