/**
 * Scheduler（定时任务）管理页面。
 *
 * 编排三组 tab 数据（Jobs / Queue / Webhooks）+ mutations（创建/删除/暂停/恢复/触发），
 * 渲染细节下放到子组件：
 *   - {@link JobCard} / {@link JobExecutions} / {@link CreateJobCard} → scheduler-components.tsx
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus, Webhook } from "lucide-react";
import { toast } from "sonner";
import { schedulerApi, type SchedulerQueue } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import {
  JobCard,
  CreateJobCard,
  type JobCardActions,
} from "./scheduler-components";

// ─── Main Page ────────────────────────────────────────────────────

export default function SchedulerPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("scheduler.title"));
  const qc = useQueryClient();

  // ── 页面状态 ──
  /** 是否展开新建表单 */
  const [showCreate, setShowCreate] = useState(false);
  /** 当前 tab */
  const [tab, setTab] = useState<"jobs" | "queue" | "webhooks">("jobs");
  /** 待删除确认的 job ID */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── 数据查询 ──
  const jobsQuery = useQuery({
    queryKey: ["scheduler-jobs"],
    queryFn: () => schedulerApi.listJobs(),
  });
  const queueQuery = useQuery({
    queryKey: ["scheduler-queue"],
    queryFn: () => schedulerApi.queue(),
  });
  const webhookQuery = useQuery({
    queryKey: ["scheduler-webhooks"],
    queryFn: () => schedulerApi.webhookAudit({ limit: 50 }),
    enabled: tab === "webhooks",
  });

  const jobs = jobsQuery.data ?? [];
  const queue: SchedulerQueue | null = queueQuery.data ?? null;

  // ── Mutations ──
  const { createMut, deleteMut, pauseMut, resumeMut, triggerMut } =
    useSchedulerMutations(qc);

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

  // ── Tab 切换 ──
  const TAB_KEYS = ["jobs", "queue", "webhooks"] as const;
  const TAB_LABELS: Record<string, string> = {
    jobs: t("scheduler.title"),
    queue: t("scheduler.running"),
    webhooks: t("scheduler.webhooks"),
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* 页面头部 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Clock className="size-5 text-brand" />
            {t("scheduler.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("scheduler.subtitle")}
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(!showCreate)}
          size="sm"
          className="h-11 md:h-9"
        >
          <Plus className="mr-1 size-4" />
          {t("scheduler.newJob")}
        </Button>
      </div>

      {/* 队列状态迷你栏 */}
      {queue && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            {t("scheduler.queueRunning", {
              count: String(queue.running),
            })}
          </span>
          <span>
            {t("scheduler.queuePending", {
              count: String(queue.pending),
            })}
          </span>
          <span>
            {t("scheduler.queueMaxConcurrency", {
              count: String(queue.maxConcurrency),
            })}
          </span>
        </div>
      )}

      {/* Tab 切换器（ARIA tablist + 键盘导航） */}
      <div
        className="flex gap-1 border-b"
        role="tablist"
        aria-label={t("scheduler.title")}
      >
        {TAB_KEYS.map((tabKey) => (
          <button
            type="button"
            key={tabKey}
            role="tab"
            aria-selected={tab === tabKey}
            onClick={() => setTab(tabKey)}
            onKeyDown={(e) => {
              const idx = TAB_KEYS.indexOf(tabKey);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                setTab(TAB_KEYS[(idx + 1) % TAB_KEYS.length]);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                setTab(TAB_KEYS[(idx - 1 + TAB_KEYS.length) % TAB_KEYS.length]);
              }
            }}
            className={cn(
              "min-h-[44px] px-3 py-2 text-sm font-medium capitalize transition-colors md:min-h-0",
              tab === tabKey
                ? "border-b-2 border-brand text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABELS[tabKey]}
          </button>
        ))}
      </div>

      {/* 新建 Job 表单 */}
      {showCreate && tab === "jobs" && (
        <CreateJobCard
          onClose={() => setShowCreate(false)}
          onCreate={(data) => createMut.mutate(data)}
        />
      )}

      {/* Jobs tab */}
      {tab === "jobs" && (
        <div role="tabpanel">
          <QueryBoundary
            query={jobsQuery}
            skeleton={<JobsSkeleton />}
          >
            {(jobs) =>
              jobs.length === 0 ? (
                <EmptyState
                  icon={Clock}
                  title={t("scheduler.noJobs")}
                  description={t("scheduler.noJobsDesc")}
                  action={{
                    label: t("scheduler.newJob"),
                    onClick: () => setShowCreate(true),
                  }}
                />
              ) : (
                <div className="space-y-2">
                  {jobs.map((job) => (
                    <JobCard key={job.id} job={job} actions={jobActions} />
                  ))}
                </div>
              )
            }
          </QueryBoundary>
        </div>
      )}

      {/* Queue tab */}
      {tab === "queue" && (
        <div role="tabpanel">
          <QueryBoundary
            query={queueQuery}
            skeleton={<QueueSkeleton />}
          >
            {(queue) =>
              queue ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <StatCard
                    value={queue.running}
                    label={t("scheduler.running")}
                  />
                  <StatCard
                    value={queue.pending}
                    label={t("scheduler.pending")}
                  />
                  <StatCard
                    value={queue.maxConcurrency}
                    label={t("scheduler.maxConcurrency")}
                  />
                </div>
              ) : (
                <EmptyState
                  icon={Clock}
                  title={t("scheduler.queueStatusUnavailable")}
                  description={t("scheduler.queueStatusUnavailableDesc")}
                />
              )
            }
          </QueryBoundary>
        </div>
      )}

      {/* Webhooks tab */}
      {tab === "webhooks" && (
        <div role="tabpanel">
          <QueryBoundary
            query={webhookQuery}
            skeleton={<WebhooksSkeleton />}
          >
            {(webhooks) =>
              webhooks.length === 0 ? (
                <EmptyState
                  icon={Webhook}
                  title={t("scheduler.noWebhookDeliveries")}
                  description={t("scheduler.webhookHint")}
                />
              ) : (
                <div className="space-y-2">
                  {webhooks.map((entry) => (
                    <Card key={entry.id}>
                      <CardContent className="py-3">
                        <div className="flex items-center gap-2 text-sm">
                          <Badge
                            variant="outline"
                            className="text-[11px] font-mono"
                          >
                            {entry.token.slice(0, 8)}…
                          </Badge>
                          <span className="text-muted-foreground">
                            {entry.result}
                          </span>
                          <span className="ml-auto text-[11px] text-muted-foreground/70">
                            {fmtDT(new Date(entry.createdAt))}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )
            }
          </QueryBoundary>
        </div>
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("scheduler.deleteJobConfirm", {
          name: t("scheduler.job"),
        })}
        description={t("scheduler.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) {
            deleteMut.mutate(deleteTarget);
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────

/** Jobs 列表加载骨架屏 */
function JobsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-3">
            <div className="space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Queue 面板加载骨架屏 */
function QueueSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-4 text-center">
            <div className="mx-auto h-8 w-16 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Webhooks 面板加载骨架屏 */
function WebhooksSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-3">
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── 小组件 ────────────────────────────────────────────────────────

/** 队列统计卡片（单个数字 + 标签） */
function StatCard({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  return (
    <Card>
      <CardContent className="py-4 text-center">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

// ─── Mutations Hook ───────────────────────────────────────────────

/** 统一封装 scheduler 的 5 个 mutation（创建/删除/暂停/恢复/触发） */
function useSchedulerMutations(qc: ReturnType<typeof useQueryClient>) {
  const t = useT();
  const invalidateJobs = () =>
    qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });

  const createMut = useMutation({
    mutationFn: schedulerApi.createJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobCreated"));
      invalidateJobs();
      // 不在这里 setShowCreate(false) —— 由页面组件在 onCreate 回调中处理
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: schedulerApi.deleteJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobDeleted"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pauseMut = useMutation({
    mutationFn: schedulerApi.pauseJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobPaused"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resumeMut = useMutation({
    mutationFn: schedulerApi.resumeJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobResumed"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const triggerMut = useMutation({
    mutationFn: schedulerApi.triggerJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobTriggered"));
      invalidateJobs();
      qc.invalidateQueries({ queryKey: ["scheduler-queue"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return { createMut, deleteMut, pauseMut, resumeMut, triggerMut };
}
