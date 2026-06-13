/**
 * 实时事件 hook。
 *
 * 订阅 WebSocket 事件总线，自动 invalidate React Query 缓存 + 显示 toast 通知。
 * 覆盖：task / agent / notification / scheduler / MCP / mission / agent_dialogue 七大类事件。
 * 仅在 DashboardLayout 挂载时注册（全局唯一）。
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";
import { useMissionStore, type Mission, type MissionTask } from "@/lib/stores/mission-store";
import { useAgentChatStore, type AgentChatMessage } from "@/lib/stores/agent-chat-store";

export function useRealtimeEvents() {
  const queryClient = useQueryClient();
  const subscribe = useWsStore((s) => s.subscribe);
  const t = useT();

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(
      subscribe("task.created", () => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      })
    );
    unsubs.push(
      subscribe("task.completed", () => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      })
    );
    unsubs.push(
      subscribe("task.failed", (payload) => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        const p = payload as { targetAgent?: string; error?: string };
        toast.error(p.targetAgent ? t("events.taskFailedAgent", { agent: p.targetAgent }) : t("events.taskFailed"), {
          description: p.error,
        });
      })
    );
    unsubs.push(
      subscribe("task.started", () => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      })
    );
    unsubs.push(
      subscribe("task.cancelled", () => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      })
    );
    unsubs.push(
      subscribe("agent.enabled", () => {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      })
    );
    unsubs.push(
      subscribe("agent.disabled", () => {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      })
    );
    unsubs.push(
      subscribe("agent.crashed", (payload) => {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
        const p = payload as { name?: string; error?: string };
        toast.error(t("events.agentCrashed", { name: p.name ?? "unknown" }), {
          description: p.error,
        });
      })
    );

    // ─── Notifications ──────────────────────────────────────────────────
    unsubs.push(
      subscribe("notification.created", () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["notification-count"] });
      })
    );
    unsubs.push(
      subscribe("notification.read", () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["notification-count"] });
      })
    );

    // ─── Scheduler ──────────────────────────────────────────────────────
    const schedulerEvents = [
      "scheduler.job_enqueued",
      "scheduler.job_completed",
      "scheduler.chain_step_completed",
      "scheduler.reminder_fired",
    ] as const;
    for (const evt of schedulerEvents) {
      unsubs.push(
        subscribe(evt, () => {
          queryClient.invalidateQueries({ queryKey: ["scheduler-jobs"] });
          queryClient.invalidateQueries({ queryKey: ["scheduler-queue"] });
        })
      );
    }
    // scheduler.job_failed needs both invalidation + toast
    unsubs.push(
      subscribe("scheduler.job_failed", (payload) => {
        queryClient.invalidateQueries({ queryKey: ["scheduler-jobs"] });
        queryClient.invalidateQueries({ queryKey: ["scheduler-queue"] });
        const p = payload as { name?: string; error?: string };
        toast.error(t("events.jobFailed", { name: p.name ?? "unknown" }), {
          description: p.error,
        });
      })
    );
    unsubs.push(
      subscribe("scheduler.chain_approval_pending", () => {
        queryClient.invalidateQueries({ queryKey: ["scheduler-jobs"] });
        toast.info(t("events.chainApproval"), {
          description: t("events.chainApprovalDesc"),
        });
      })
    );

    // ─── MCP ────────────────────────────────────────────────────────────
    unsubs.push(
      subscribe("mcp.connected", () => {
        queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
      })
    );
    unsubs.push(
      subscribe("mcp.disconnected", () => {
        queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
      })
    );
    unsubs.push(
      subscribe("mcp.failed", (payload) => {
        const p = payload as { serverId?: string; error?: string };
        toast.error(t("events.mcpServerFailed", { serverId: p.serverId ?? "unknown" }), {
          description: p.error,
        });
      })
    );
    unsubs.push(
      subscribe("mcp.tools_changed", () => {
        queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
      })
    );

    // ─── 13.0 Mission 实时更新（§5.1.1 前端实时信息流） ─────────────────
    const missionStore = useMissionStore.getState();

    /** mission.created → 添加新 mission 到列表 */
    unsubs.push(
      subscribe("mission.created", (payload) => {
        const p = payload as { missionId: string; goal: string; taskCount: number };
        queryClient.invalidateQueries({ queryKey: ["missions"] });
        toast.info(t("events.missionCreated", { goal: p.goal ?? "" }), {
          description: t("events.missionCreatedDesc", { count: p.taskCount ?? 0 }),
        });
      })
    );

    /** mission.status_changed → 更新 mission 状态 */
    unsubs.push(
      subscribe("mission.status_changed", (payload) => {
        const p = payload as { missionId: string; oldStatus: string; newStatus: string };
        missionStore.updateMission(p.missionId, { status: p.newStatus as Mission["status"] });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
        if (p.newStatus === "completed") {
          toast.success(t("events.missionCompleted"));
        }
      })
    );

    /** mission.task_updated → 更新任务进度 */
    unsubs.push(
      subscribe("mission.task_updated", (payload) => {
        const p = payload as { missionId: string; taskId: string; status: string; who: string };
        missionStore.updateTask(p.missionId, p.taskId, { status: p.status as MissionTask["status"] });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
      })
    );

    /** mission.completed → 整个 mission 完成 */
    unsubs.push(
      subscribe("mission.completed", (payload) => {
        const p = payload as { missionId: string; goal: string };
        missionStore.updateMission(p.missionId, { status: "completed", progressPercent: 100 });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
        toast.success(t("events.missionAllDone"));
      })
    );

    /** mission.squad_created / mission.signal / mission.handoff → 刷新列表 */
    for (const evt of ["mission.squad_created", "mission.signal", "mission.handoff", "mission.task_ready"] as const) {
      unsubs.push(
        subscribe(evt, () => {
          queryClient.invalidateQueries({ queryKey: ["missions"] });
        })
      );
    }

    // ─── 13.0 Agent 间对话实时推送（§5.1.1 agent_chat WS 事件） ───────
    const agentChatStore = useAgentChatStore.getState();

    unsubs.push(
      subscribe("agent_dialogue", (payload) => {
        const p = payload as {
          id?: string; sessionId?: string; taskId?: string;
          from?: string; to?: string; direction?: string;
          messageType?: string; content?: string; correlationId?: string;
        };
        if (p.id) {
          agentChatStore.addMessage({
            id: p.id,
            sessionId: p.sessionId ?? "",
            taskId: p.taskId,
            fromAgent: p.from ?? "",
            toAgent: p.to ?? "",
            direction: (p.direction as AgentChatMessage["direction"]) ?? "request",
            messageType: p.messageType ?? "agent.question",
            content: p.content ?? "",
            correlationId: p.correlationId,
            timestamp: Date.now(),
          });
        }
      })
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [subscribe, queryClient, t]);
}
