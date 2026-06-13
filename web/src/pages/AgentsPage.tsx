/**
 * Agent 管理页面。
 *
 * 展示已注册 Agent 的卡片网格（名称 / 状态 / 描述 / 类型 / 版本），
 * 点击卡片进入详情视图（{@link AgentDetailView}）。
 * 支持启用/禁用 Agent（带确认对话框）。
 *
 * 详情视图 → agents-components.tsx
 * Mutations → use-agent-mutations.ts
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { Bot, Power, PowerOff } from "lucide-react";
import { useT } from "@/lib/i18n";
import { AgentDetailView } from "./agents-components";
import { useAgentMutations } from "./use-agent-mutations";

export default function AgentsPage() {
  const t = useT();
  useDocumentTitle(t("agents.title"));

  // ── 状态 ──
  /** 当前选中查看详情的 Agent 名称（null = 显示列表） */
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  /** 待禁用确认的 Agent 名称（非 null 时弹出确认框） */
  const [disableTarget, setDisableTarget] = useState<string | null>(null);

  // ── 数据查询 ──
  const agentsQuery = useQuery(queries.agents());

  // ── Mutations ──
  const { toggleAgent } = useAgentMutations();

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("agents.title")} subtitle={t("agents.subtitle")} />

      <QueryBoundary
        query={agentsQuery}
        skeleton={<AgentsGridSkeleton />}
        errorTitle={t("agents.failedToLoad")}
      >
        {(agents) => {
          // 详情视图模式
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

          // 列表视图模式
          return (
            <>
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((agent, i) => (
                  <AgentCard
                    key={agent.name}
                    agent={agent}
                    index={i}
                    onSelect={() => setSelectedAgent(agent.name)}
                    onToggle={(enable) => {
                      if (!enable) {
                        setDisableTarget(agent.name);
                      } else {
                        toggleAgent.mutate({ name: agent.name, enable: true });
                      }
                    }}
                  />
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

      {/* 禁用确认对话框 */}
      <ConfirmDialog
        open={!!disableTarget}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={t("agents.disableConfirmTitle")}
        description={t("agents.disableConfirmDesc", {
          name: disableTarget ?? "",
        })}
        actionLabel={t("agents.disableAgent")}
        onAction={() => {
          if (disableTarget)
            toggleAgent.mutate({ name: disableTarget, enable: false });
        }}
      />
    </div>
  );
}

// ─── 子组件 ─────────────────────────────────────────────────────────

/** Agent 卡片（名称 / 状态 / 描述 / 类型 / 版本 + 启停按钮） */
function AgentCard({
  agent,
  index,
  onSelect,
  onToggle,
}: {
  agent: { name: string; status: string; description?: string; kind?: string; version?: string };
  /** 列表序号（stagger 动画） */
  index: number;
  onSelect: () => void;
  onToggle: (enable: boolean) => void;
}) {
  const t = useT();
  const isEnabled = agent.status === "enabled";

  return (
    <Card
      className={`cursor-pointer card-lift hover:border-ring/50 active:border-ring/30 transition-all stagger-${Math.min(index + 1, 8)}`}
      onClick={onSelect}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-brand" />
            <CardTitle>{agent.name}</CardTitle>
          </div>
          <Badge
            key={agent.status}
            variant={isEnabled ? "success" : "secondary"}
            className="animate-badge-pop"
          >
            {isEnabled ? t("status.active") : t("status.disabled")}
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
          <IconButton
            title={
              isEnabled ? t("agents.disableAgent") : t("agents.enableAgent")
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggle(!isEnabled);
            }}
          >
            {isEnabled ? (
              <PowerOff className="size-4" />
            ) : (
              <Power className="size-4" />
            )}
          </IconButton>
        </div>
      </CardContent>
    </Card>
  );
}

/** Agent 列表加载骨架屏 */
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
