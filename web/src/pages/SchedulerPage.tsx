import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Plus,
  Play,
  Pause,
  Trash2,
  RotateCw,
  History,
  ChevronDown,
  ChevronRight,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import {
  schedulerApi,
  type SchedulerJob,
  type SchedulerQueue,
} from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

// ─── Status badge helper ───────────────────────────────────────────────────

/** JobStatusBadge — 翻译 job 状态显示 */
function JobStatusBadge({ status }: { status: string }) {
  const t = useT();
  const variant =
    status === "paused"
      ? "secondary"
      : status === "running"
        ? "default"
        : "outline";
  return (
    <Badge variant={variant} className="text-[11px]">
      {t(`status.${status}`) ?? status}
    </Badge>
  );
}

// ─── Executions panel (inline expand) ──────────────────────────────────────

function JobExecutions({ jobId }: { jobId: string }) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  const [show, setShow] = useState(false);
  const execQuery = useQuery({
    queryKey: ["scheduler-executions", jobId],
    queryFn: () => schedulerApi.executions(jobId, { limit: 20 }),
    enabled: show,
  });

  return (
    <div>
      <button
        onClick={() => setShow(!show)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        {show ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <History className="size-3" />
        {t("scheduler.executionHistory")}
      </button>
      {show && (
        <div className="mt-2 space-y-1 pl-4">
          <QueryBoundary query={execQuery} skeleton={<p className="text-[11px] text-muted-foreground">{t("common.loading")}</p>}>
            {(execs) => execs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t("scheduler.noExecutions")}</p>
            ) : (
              execs.map((ex) => (
                <div
                  key={ex.id}
                  className="flex items-center gap-2 rounded border px-2 py-1.5 text-[11px]"
                >
                  <Badge
                    variant={ex.status === "completed" ? "outline" : "destructive"}
                    className="text-[11px]"
                  >
                    {t(`status.${ex.status}`) ?? ex.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    {fmtDT(new Date(ex.startedAt))}
                  </span>
                  {ex.finishedAt && (
                    <span className="text-muted-foreground/70">
                      ({((ex.finishedAt - ex.startedAt) / 1000).toFixed(1)}s)
                    </span>
                  )}
                  {ex.error && (
                    <span className="truncate text-destructive">{ex.error}</span>
                  )}
                </div>
              ))
            )}
          </QueryBoundary>
        </div>
      )}
    </div>
  );
}

// ─── Create job dialog ─────────────────────────────────────────────────────

function CreateJobCard({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; cron: string; prompt: string }) => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const t = useT();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("scheduler.newScheduledJob")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder={t("scheduler.jobName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 md:h-8"
        />
        <Input
          placeholder={t("scheduler.cronPlaceholder")}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className="h-11 md:h-8 font-mono text-sm"
        />
        <textarea
          placeholder={t("scheduler.promptPlaceholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="flex w-full rounded-md border bg-transparent px-3 py-2 text-[16px] md:text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!name.trim() || !cron.trim() || !prompt.trim()}
            onClick={() => onCreate({ name, cron, prompt })}
          >
            {t("common.create")}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("scheduler.title"));
  const qc = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<"jobs" | "queue" | "webhooks">("jobs");
  /** 删除确认对话框状态 */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Jobs list
  const jobsQuery = useQuery({
    queryKey: ["scheduler-jobs"],
    queryFn: () => schedulerApi.listJobs(),
  });

  // Queue status
  const queueQuery = useQuery({
    queryKey: ["scheduler-queue"],
    queryFn: () => schedulerApi.queue(),
  });

  // Webhook audit
  const webhookQuery = useQuery({
    queryKey: ["scheduler-webhooks"],
    queryFn: () => schedulerApi.webhookAudit({ limit: 50 }),
    enabled: tab === "webhooks",
  });

  // Mutations
  const createMut = useMutation({
    mutationFn: schedulerApi.createJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobCreated"));
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
      setShowCreate(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: schedulerApi.deleteJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobDeleted"));
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pauseMut = useMutation({
    mutationFn: schedulerApi.pauseJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobPaused"));
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resumeMut = useMutation({
    mutationFn: schedulerApi.resumeJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobResumed"));
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const triggerMut = useMutation({
    mutationFn: schedulerApi.triggerJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobTriggered"));
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
      qc.invalidateQueries({ queryKey: ["scheduler-queue"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const jobs: SchedulerJob[] = jobsQuery.data ?? [];
  const queue: SchedulerQueue | null = queueQuery.data ?? null;

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
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

      {/* Queue status mini-bar */}
      {queue && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            {t("scheduler.queueRunning", { count: String(queue.running) })}
          </span>
          <span>
            {t("scheduler.queuePending", { count: String(queue.pending) })}
          </span>
          <span>
            {t("scheduler.queueMaxConcurrency", { count: String(queue.maxConcurrency) })}
          </span>
        </div>
      )}

      {/* Tab switcher — ARIA tablist 模式 */}
      <div className="flex gap-1 border-b" role="tablist" aria-label={t("scheduler.title")}>
        {(["jobs", "queue", "webhooks"] as const).map((tabKey) => (
          <button
            key={tabKey}
            role="tab"
            aria-selected={tab === tabKey}
            onClick={() => setTab(tabKey)}
            onKeyDown={(e) => {
              const tabs = ["jobs", "queue", "webhooks"] as const;
              const idx = tabs.indexOf(tabKey);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                setTab(tabs[(idx + 1) % tabs.length]);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                setTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
              }
            }}
            className={cn(
              "px-3 py-2 text-sm font-medium capitalize transition-colors min-h-[44px] md:min-h-0",
              tab === tabKey
                ? "border-b-2 border-brand text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tabKey === "jobs" ? t("scheduler.title") : tabKey === "queue" ? t("scheduler.running") : t("scheduler.webhooks")}
          </button>
        ))}
      </div>

      {/* Create job form */}
      {showCreate && tab === "jobs" && (
        <CreateJobCard
          onClose={() => setShowCreate(false)}
          onCreate={(data) => createMut.mutate(data)}
        />
      )}

      {/* Jobs tab */}
      {tab === "jobs" && (
        <div role="tabpanel">
        <QueryBoundary query={jobsQuery} skeleton={<div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Card key={i}><CardContent className="py-3"><div className="space-y-2"><div className="h-4 w-1/3 animate-pulse rounded bg-muted" /><div className="h-3 w-2/3 animate-pulse rounded bg-muted" /></div></CardContent></Card>)}</div>}>
          {(jobs) => jobs.length === 0 ? (
            <EmptyState
              icon={Clock}
              title={t("scheduler.noJobs")}
              description={t("scheduler.noJobsDesc")}
              action={{ label: t("scheduler.newJob"), onClick: () => setShowCreate(true) }}
            />
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <Card key={job.id} className="group">
                  <CardContent className="py-3 space-y-2">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{job.name}</span>
                          <JobStatusBadge status={job.status} />
                          {!job.enabled && (
                            <Badge variant="secondary" className="text-[11px]">
                              {t("common.disabled")}
                            </Badge>
                          )}
                        </div>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {job.cron}
                        </p>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {job.prompt}
                        </p>
                        <div className="flex gap-3 text-[11px] text-muted-foreground/70">
                          {job.lastRunAt && (
                            <span>
                              {t("scheduler.last", { time: fmtDT(new Date(job.lastRunAt)) })}
                            </span>
                          )}
                          {job.nextRunAt && (
                            <span>
                              {t("scheduler.next", { time: fmtDT(new Date(job.nextRunAt)) })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        {job.status !== "paused" && job.enabled && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 md:size-8"
                            title={t("common.pause")}
                            aria-label={t("common.pause")}
                            onClick={() => pauseMut.mutate(job.id)}
                          >
                            <Pause className="size-3.5" />
                          </Button>
                        )}
                        {job.status === "paused" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 md:size-8"
                            title={t("common.resume")}
                            aria-label={t("common.resume")}
                            onClick={() => resumeMut.mutate(job.id)}
                          >
                            <Play className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 md:size-8"
                          title={t("scheduler.triggerNow")}
                          aria-label={t("scheduler.triggerNow")}
                          onClick={() => triggerMut.mutate(job.id)}
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("size-11 md:size-8 text-destructive hover:text-destructive")}
                          title={t("common.delete")}
                          aria-label={t("common.delete")}
                          onClick={() => setDeleteTarget(job.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    <JobExecutions jobId={job.id} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </QueryBoundary>
        </div>
      )}

      {/* Queue tab */}
      {tab === "queue" && (
        <div role="tabpanel">
        <QueryBoundary query={queueQuery} skeleton={<div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="py-4 text-center"><div className="mx-auto h-8 w-16 animate-pulse rounded bg-muted" /></CardContent></Card>)}</div>}>
          {(queue) => queue ? (
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.running}</p>
                  <p className="text-sm text-muted-foreground">{t("scheduler.running")}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.pending}</p>
                  <p className="text-sm text-muted-foreground">{t("scheduler.pending")}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.maxConcurrency}</p>
                  <p className="text-sm text-muted-foreground">{t("scheduler.maxConcurrency")}</p>
                </CardContent>
              </Card>
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
        <QueryBoundary query={webhookQuery} skeleton={<div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="py-3"><div className="h-4 w-1/3 animate-pulse rounded bg-muted" /></CardContent></Card>)}</div>}>
          {(webhooks) => webhooks.length === 0 ? (
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
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("scheduler.deleteJobConfirm", { name: t("scheduler.job") })}
        description={t("scheduler.deleteConfirmDesc")}
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
