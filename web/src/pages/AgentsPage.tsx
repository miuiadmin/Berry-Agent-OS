
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queries, apiPost, type TaskInfo } from "@/lib/api";
import { useWsStore } from "@/lib/stores/ws-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { QueryBoundary } from "@/components/shared/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { Bot, Power, PowerOff, ArrowLeft, Clock, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

function AgentsGridSkeleton() {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-5 w-24" />
            </div>
            <Skeleton className="mt-2 h-4 w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AgentsPage() {
  const t = useT();
  useDocumentTitle(t("agents.title"));
  const agentsQuery = useQuery(queries.agents());
  const queryClient = useQueryClient();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<string | null>(null);

  const toggleAgent = useMutation({
    mutationFn: async ({ name, enable }: { name: string; enable: boolean }) => {
      await apiPost(`/api/agents/${name}/${enable ? "enable" : "disable"}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(t("agents.statusUpdated"));
    },
    onError: (err: Error) => {
      toast.error(err.message || t("agents.failedToUpdate"));
    },
  });

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">{t("agents.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("agents.subtitle")}</p>

      <QueryBoundary
        query={agentsQuery}
        skeleton={<AgentsGridSkeleton />}
        errorTitle={t("agents.failedToLoad")}
      >
        {(agents) => {
          if (selectedAgent) {
            const agent = agents.find((a) => a.name === selectedAgent);
            if (!agent) {
              setSelectedAgent(null);
              return null;
            }
            return (
              <AgentDetailView
                agent={agent}
                onBack={() => setSelectedAgent(null)}
                onToggle={(enable) => {
                  if (!enable) {
                    setDisableTarget(agent.name);
                  } else {
                    toggleAgent.mutate({ name: agent.name, enable: true });
                  }
                }}
              />
            );
          }

          return (
            <>
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((agent, i) => (
                  <Card key={agent.name} className={`cursor-pointer card-lift hover:border-ring/50 active:border-ring/30 transition-all stagger-${Math.min(i + 1, 8)}`} onClick={() => setSelectedAgent(agent.name)}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Avatar name={agent.name} size="sm" fallback={<Bot className="size-3" />} className="text-accent" />
                          <CardTitle>{agent.name}</CardTitle>
                        </div>
                        <Badge key={agent.status} variant={agent.status === "enabled" ? "success" : "secondary"} className="animate-badge-pop">
                          {agent.status === "enabled" ? t("status.active") : t("status.disabled")}
                        </Badge>
                      </div>
                      {agent.description && (
                        <CardDescription>{agent.description}</CardDescription>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {agent.kind && (
                            <span className="text-[11px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                              {agent.kind}
                            </span>
                          )}
                          {agent.version && (
                            <span className="text-[11px] text-muted-foreground">
                              v{agent.version}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 md:size-8"
                          aria-label={agent.status === "enabled" ? t("agents.disableAgent") : t("agents.enableAgent")}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (agent.status === "enabled") {
                              setDisableTarget(agent.name);
                            } else {
                              toggleAgent.mutate({ name: agent.name, enable: true });
                            }
                          }}
                        >
                          {agent.status === "enabled" ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              {agents.length === 0 && (
                <EmptyState
                  icon={Bot}
                  title={t("agents.noAgents")}
                  description={t("agents.noAgentsDesc")}
                />
              )}
            </>
          );
        }}
      </QueryBoundary>

      <AlertDialog
        open={!!disableTarget}
        onOpenChange={(open) => { if (!open) setDisableTarget(null); }}
        title={t("agents.disableConfirmTitle")}
        description={t("agents.disableConfirmDesc", { name: disableTarget ?? "" })}
        actionLabel={t("agents.disableAgent")}
        onAction={() => {
          if (disableTarget) toggleAgent.mutate({ name: disableTarget, enable: false });
        }}
      />
    </div>
  );
}

function AgentDetailView({
  agent,
  onBack,
  onToggle,
}: {
  agent: { name: string; status: string; description?: string; kind?: string; version?: string };
  onBack: () => void;
  onToggle: (enable: boolean) => void;
}) {
  const t = useT();
  const { formatDate, formatTime } = useDateFormat();
  const { data: tasksData } = useQuery(queries.tasks({ limit: 50 }));
  const [events, setEvents] = useState<Array<{ event: string; ts: number }>>([]);
  const subscribe = useWsStore((s) => s.subscribe);

  const recentTasks = (tasksData?.items ?? [])
    .filter((t: TaskInfo) => t.targetAgent === agent.name)
    .slice(0, 5);

  useEffect(() => {
    const unsubs = [
      subscribe("agent.enabled", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) {
          setEvents((prev) => [...prev.slice(-9), { event: "enabled", ts: Date.now() }]);
        }
      }),
      subscribe("agent.disabled", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) {
          setEvents((prev) => [...prev.slice(-9), { event: "disabled", ts: Date.now() }]);
        }
      }),
      subscribe("agent.crashed", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) {
          setEvents((prev) => [...prev.slice(-9), { event: "crashed", ts: Date.now() }]);
        }
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [agent.name, subscribe]);

  return (
    <div className="mt-4 animate-page-in">
      <Button variant="ghost" size="sm" className="mb-4" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t("agents.backToAgents")}
      </Button>

      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{agent.name}</h1>
        <Badge key={agent.status} variant={agent.status === "enabled" ? "success" : "secondary"} className="animate-badge-pop">
          {agent.status === "enabled" ? t("status.active") : t("status.disabled")}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onToggle(agent.status !== "enabled")}
        >
          {agent.status === "enabled" ? (
            <><PowerOff className="size-3.5" /> {t("agents.disableAgent")}</>
          ) : (
            <><Power className="size-3.5" /> {t("agents.enableAgent")}</>
          )}
        </Button>
      </div>

      {agent.description && (
        <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("common.details")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-medium text-muted-foreground">{t("common.status")}</dt>
              <dd className="mt-0.5">{t(`status.${agent.status}`) ?? agent.status}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t("agents.kind")}</dt>
              <dd className="mt-0.5">{agent.kind ?? "—"}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t("agents.version")}</dt>
              <dd className="mt-0.5">{agent.version ? `v${agent.version}` : "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t("agents.recentTasks")}</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTasks.length === 0 ? (
            <EmptyState icon={ListTodo} title={t("agents.noTasksForAgent")} description={t("agents.noTasksForAgent")} />
          ) : (
            <div className="space-y-2">
              {recentTasks.map((task: TaskInfo, i: number) => (
                <div key={task.id} className={cn("flex items-center justify-between rounded-lg border px-3 py-2", `stagger-${Math.min(i + 1, 8)}`)}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">{task.id.slice(0, 8)}</span>
                    <span className="text-sm">{task.taskType}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        task.status === "completed" ? "success"
                          : task.status === "failed" ? "danger"
                          : task.status === "running" ? "warning"
                          : "secondary"
                      }
                    >
                      {t(`status.${task.status}`) ?? task.status}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {formatDate(new Date(task.createdAt))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t("agents.liveEvents")}</CardTitle>
          <CardDescription>{t("agents.eventsSinceOpened")}</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState icon={Clock} title={t("agents.noEvents")} description={t("agents.listening")} />
          ) : (
            <div className="space-y-1.5">
              {events.map((ev) => (
                <div key={ev.ts} className="flex items-center gap-2 text-xs animate-slide-left">
                  <Clock className="size-3 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {formatTime(new Date(ev.ts))}
                  </span>
                  <Badge
                    variant={
                      ev.event === "enabled" ? "success"
                        : ev.event === "crashed" ? "danger"
                        : "secondary"
                    }
                  >
                    {t(`status.${ev.event}`) ?? ev.event}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
