
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queries, apiPost } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { Bot, Power, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { AgentDetailView } from "./agents-components";

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
                          <Bot className="size-4 text-brand" />
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

      <ConfirmDialog
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
