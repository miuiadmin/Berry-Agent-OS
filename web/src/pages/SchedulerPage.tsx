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
  type SchedulerExecution,
  type SchedulerQueue,
} from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

// ─── Status badge helper ───────────────────────────────────────────────────

function JobStatusBadge({ status }: { status: string }) {
  const variant =
    status === "paused"
      ? "secondary"
      : status === "running"
        ? "default"
        : "outline";
  return (
    <Badge variant={variant} className="text-[11px] capitalize">
      {status}
    </Badge>
  );
}

// ─── Executions panel (inline expand) ──────────────────────────────────────

function JobExecutions({ jobId }: { jobId: string }) {
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
        Execution history
      </button>
      {show && (
        <div className="mt-2 space-y-1 pl-4">
          <QueryBoundary query={execQuery} skeleton={<p className="text-[11px] text-muted-foreground">Loading…</p>}>
            {(execs) => execs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No executions yet.</p>
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
                    {ex.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    {new Date(ex.startedAt).toLocaleString()}
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">New Scheduled Job</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Job name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 md:h-8"
        />
        <Input
          placeholder="Cron expression (e.g. 0 9 * * 1-5)"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className="h-11 md:h-8 font-mono text-sm"
        />
        <textarea
          placeholder="Prompt to execute on each run"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="flex w-full rounded-md border bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!name.trim() || !cron.trim() || !prompt.trim()}
            onClick={() => onCreate({ name, cron, prompt })}
          >
            Create
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  useDocumentTitle("Scheduler");
  const qc = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<"jobs" | "queue" | "webhooks">("jobs");

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
      toast.success("Job created");
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
      setShowCreate(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: schedulerApi.deleteJob,
    onSuccess: () => {
      toast.success("Job deleted");
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pauseMut = useMutation({
    mutationFn: schedulerApi.pauseJob,
    onSuccess: () => {
      toast.success("Job paused");
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resumeMut = useMutation({
    mutationFn: schedulerApi.resumeJob,
    onSuccess: () => {
      toast.success("Job resumed");
      qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const triggerMut = useMutation({
    mutationFn: schedulerApi.triggerJob,
    onSuccess: () => {
      toast.success("Job triggered");
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
            Scheduler
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage scheduled jobs, cron tasks, and webhooks
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(!showCreate)}
          size="sm"
          className="h-11 md:h-9"
        >
          <Plus className="mr-1 size-4" />
          New Job
        </Button>
      </div>

      {/* Queue status mini-bar */}
      {queue && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            Queue: <strong className="text-foreground">{queue.running}</strong> running
          </span>
          <span>
            <strong className="text-foreground">{queue.pending}</strong> pending
          </span>
          <span>
            Max concurrency: <strong className="text-foreground">{queue.maxConcurrency}</strong>
          </span>
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex gap-1 border-b">
        {(["jobs", "queue", "webhooks"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-sm font-medium capitalize transition-colors min-h-[44px] md:min-h-0",
              tab === t
                ? "border-b-2 border-brand text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
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
        <QueryBoundary query={jobsQuery} skeleton={<div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Card key={i}><CardContent className="py-3"><div className="space-y-2"><div className="h-4 w-1/3 animate-pulse rounded bg-muted" /><div className="h-3 w-2/3 animate-pulse rounded bg-muted" /></div></CardContent></Card>)}</div>}>
          {(jobs) => jobs.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No scheduled jobs"
              description="Create a cron job to run tasks on a schedule."
              action={{ label: "New Job", onClick: () => setShowCreate(true) }}
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
                              disabled
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
                              Last: {new Date(job.lastRunAt).toLocaleString()}
                            </span>
                          )}
                          {job.nextRunAt && (
                            <span>
                              Next: {new Date(job.nextRunAt).toLocaleString()}
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
                            title="Pause"
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
                            title="Resume"
                            onClick={() => resumeMut.mutate(job.id)}
                          >
                            <Play className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 md:size-8"
                          title="Trigger now"
                          onClick={() => triggerMut.mutate(job.id)}
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("size-11 md:size-8 text-destructive hover:text-destructive")}
                          title="Delete"
                          onClick={() => {
                            if (confirm(`Delete job "${job.name}"?`)) {
                              deleteMut.mutate(job.id);
                            }
                          }}
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
      )}

      {/* Queue tab */}
      {tab === "queue" && (
        <QueryBoundary query={queueQuery} skeleton={<div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="py-4 text-center"><div className="mx-auto h-8 w-16 animate-pulse rounded bg-muted" /></CardContent></Card>)}</div>}>
          {(queue) => queue ? (
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.running}</p>
                  <p className="text-sm text-muted-foreground">Running</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.pending}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-2xl font-bold">{queue.maxConcurrency}</p>
                  <p className="text-sm text-muted-foreground">Max Concurrency</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <EmptyState icon={Clock} title="Queue status unavailable" description="Connect to the backend to see queue status." />
          )}
        </QueryBoundary>
      )}

      {/* Webhooks tab */}
      {tab === "webhooks" && (
        <QueryBoundary query={webhookQuery} skeleton={<div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="py-3"><div className="h-4 w-1/3 animate-pulse rounded bg-muted" /></CardContent></Card>)}</div>}>
          {(webhooks) => webhooks.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No webhook deliveries"
              description="Webhook audit entries will appear here."
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
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </QueryBoundary>
      )}
    </div>
  );
}
