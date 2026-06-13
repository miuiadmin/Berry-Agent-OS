/**
 * Agents 页面的详情视图组件。
 *
 * 从 AgentsPage 拆出：展示单个 Agent 的详情（状态 / 描述 / 元数据 /
 * 最近任务 / 实时事件流），含 WS 事件订阅。
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries, type TaskInfo } from "@/lib/api";
import { taskStatusVariant } from "@/lib/format";
import { useWsStore } from "@/lib/stores/ws-store";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Power, PowerOff, ArrowLeft, Clock, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

/** Agent 详情入参（来自列表项） */
export interface AgentDetailInput {
  name: string;
  status: string;
  description?: string;
  kind?: string;
  version?: string;
}

/**
 * Agent 详情视图。
 *
 * 订阅 agent.enabled / disabled / crashed 三个 WS 事件，维护打开后的实时事件流。
 */
export function AgentDetailView({
  agent,
  onBack,
  onToggle,
}: {
  agent: AgentDetailInput;
  onBack: () => void;
  onToggle: (enable: boolean) => void;
}) {
  const t = useT();
  const { formatDate, formatTime } = useDateFormat();
  const { data: tasksData } = useQuery(queries.tasks({ limit: 50 }));
  /** 打开详情后收集的实时事件（最多保留 10 条） */
  const [events, setEvents] = useState<Array<{ event: string; ts: number }>>([]);
  const subscribe = useWsStore((s) => s.subscribe);

  /** 该 agent 的最近 5 条任务 */
  const recentTasks = (tasksData?.items ?? [])
    .filter((t: TaskInfo) => t.targetAgent === agent.name)
    .slice(0, 5);

  // 订阅 agent 生命周期事件，仅记录本 agent 的事件
  useEffect(() => {
    /** 记录一条事件（保留最近 10 条） */
    const record = (event: string) =>
      setEvents((prev) => [...prev.slice(-9), { event, ts: Date.now() }]);

    const unsubs = [
      subscribe("agent.enabled", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) record("enabled");
      }),
      subscribe("agent.disabled", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) record("disabled");
      }),
      subscribe("agent.crashed", (payload) => {
        const p = payload as { name?: string };
        if (p.name === agent.name) record("crashed");
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [agent.name, subscribe]);

  const isEnabled = agent.status === "enabled";

  return (
    <div className="mt-4 animate-page-in">
      {/* 返回列表 */}
      <Button variant="ghost" size="default" className="mb-4" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t("agents.backToAgents")}
      </Button>

      {/* 标题 + 状态徽章 + 启停按钮 */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{agent.name}</h1>
        <Badge
          key={agent.status}
          variant={isEnabled ? "success" : "secondary"}
          className="animate-badge-pop"
        >
          {isEnabled ? t("status.active") : t("status.disabled")}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onToggle(!isEnabled)}
        >
          {isEnabled ? (
            <>
              <PowerOff className="size-3.5" /> {t("agents.disableAgent")}
            </>
          ) : (
            <>
              <Power className="size-3.5" /> {t("agents.enableAgent")}
            </>
          )}
        </Button>
      </div>

      {agent.description && (
        <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
      )}

      {/* 元数据卡片 */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("common.details")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <MetaItem label={t("common.status")} value={t(`status.${agent.status}`) ?? agent.status} />
            <MetaItem label={t("agents.kind")} value={agent.kind ?? "—"} />
            <MetaItem label={t("agents.version")} value={agent.version ? `v${agent.version}` : "—"} />
          </dl>
        </CardContent>
      </Card>

      {/* 最近任务 */}
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
                <div
                  key={task.id}
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-3 py-2",
                    `stagger-${Math.min(i + 1, 8)}`,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {task.id.slice(0, 8)}
                    </span>
                    <span className="text-sm">{task.taskType}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={taskStatusVariant(task.status)}>
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

      {/* 实时事件流 */}
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
                <div key={ev.ts} className="flex animate-slide-left items-center gap-2 text-xs">
                  <Clock className="size-3 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {formatTime(new Date(ev.ts))}
                  </span>
                  <Badge
                    variant={
                      ev.event === "enabled"
                        ? "success"
                        : ev.event === "crashed"
                          ? "destructive"
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

/** 元数据键值对（标签 + 值） */
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
