/**
 * 实时事件 hook。
 *
 * 订阅 WebSocket 事件总线，自动 invalidate React Query 缓存 + 显示 toast 通知。
 * 覆盖：task / agent / notification / scheduler / MCP / mission / agent_dialogue 七大类事件。
 * 仅在 DashboardLayout 挂载时注册（全局唯一）。
 *
 * 设计：使用声明式事件映射表（SIMPLE_EVENTS / TOAST_EVENTS）代替重复的
 * subscribe() 样板代码，同一组 query keys 的事件只需声明一次。
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";
import { useMissionStore, type Mission, type MissionTask } from "@/lib/stores/mission-store";
import { useAgentChatStore, type AgentChatMessage } from "@/lib/stores/agent-chat-store";

// ─── 简单事件：仅 invalidate 指定 query keys ───────────────────────

/** 事件名 → 需要刷新的 query key 列表 */
const SIMPLE_EVENTS: Record<string, string[][]> = {
  // task 生命周期
  "task.created": [["tasks"]],
  "task.completed": [["tasks"]],
  "task.started": [["tasks"]],
  "task.cancelled": [["tasks"]],
  // agent 生命周期
  "agent.enabled": [["agents"]],
  "agent.disabled": [["agents"]],
  // notification
  "notification.created": [["notifications"], ["notification-count"]],
  "notification.read": [["notifications"], ["notification-count"]],
  // MCP
  "mcp.connected": [["mcp-status"]],
  "mcp.disconnected": [["mcp-status"]],
  "mcp.tools_changed": [["mcp-status"]],
  // mission（纯刷新类）
  "mission.squad_created": [["missions"]],
  "mission.signal": [["missions"]],
  "mission.handoff": [["missions"]],
  "mission.task_ready": [["missions"]],
};

// ─── Toast 事件：invalidate + toast 通知 ──────────────────────────

/** Toast 事件的配置 */
interface ToastEventConfig {
  /** 需要刷新的 query key 列表 */
  queryKeys: string[][];
  /** 从 payload 提取 toast 参数的函数 */
  toToast: (payload: unknown, t: (key: string, args?: Record<string, string>) => string) => {
    variant: "error" | "success" | "info";
    title: string;
    description?: string;
  };
}

const TOAST_EVENTS: Record<string, ToastEventConfig> = {
  "task.failed": {
    queryKeys: [["tasks"]],
    toToast: (p, t) => {
      const { targetAgent, error } = p as { targetAgent?: string; error?: string };
      return {
        variant: "error",
        title: targetAgent
          ? t("events.taskFailedAgent", { agent: targetAgent })
          : t("events.taskFailed"),
        description: error,
      };
    },
  },
  "agent.crashed": {
    queryKeys: [["agents"]],
    toToast: (p, t) => {
      const { name, error } = p as { name?: string; error?: string };
      return {
        variant: "error",
        title: t("events.agentCrashed", { name: name ?? "unknown" }),
        description: error,
      };
    },
  },
  "scheduler.job_failed": {
    queryKeys: [["scheduler-jobs"], ["scheduler-queue"]],
    toToast: (p, t) => {
      const { name, error } = p as { name?: string; error?: string };
      return {
        variant: "error",
        title: t("events.jobFailed", { name: name ?? "unknown" }),
        description: error,
      };
    },
  },
  "scheduler.chain_approval_pending": {
    queryKeys: [["scheduler-jobs"]],
    toToast: (_p, t) => ({
      variant: "info",
      title: t("events.chainApproval"),
      description: t("events.chainApprovalDesc"),
    }),
  },
  "mcp.failed": {
    queryKeys: [["mcp-status"]],
    toToast: (p, t) => {
      const { serverId, error } = p as { serverId?: string; error?: string };
      return {
        variant: "error",
        title: t("events.mcpServerFailed", { serverId: serverId ?? "unknown" }),
        description: error,
      };
    },
  },
  "mission.created": {
    queryKeys: [["missions"]],
    toToast: (p, t) => {
      const { goal, taskCount } = p as { goal?: string; taskCount?: number };
      return {
        variant: "info",
        title: t("events.missionCreated", { goal: goal ?? "" }),
        description: t("events.missionCreatedDesc", { count: String(taskCount ?? 0) }),
      };
    },
  },
};

export function useRealtimeEvents() {
  const queryClient = useQueryClient();
  const subscribe = useWsStore((s) => s.subscribe);
  const t = useT();

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // ─── 1. 简单事件：仅 invalidate ──
    for (const [event, queryKeys] of Object.entries(SIMPLE_EVENTS)) {
      unsubs.push(
        subscribe(event, () => {
          for (const key of queryKeys) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        }),
      );
    }

    // ─── 2. Toast 事件：invalidate + toast 通知 ──
    for (const [event, config] of Object.entries(TOAST_EVENTS)) {
      unsubs.push(
        subscribe(event, (payload) => {
          for (const key of config.queryKeys) {
            queryClient.invalidateQueries({ queryKey: key });
          }
          const { variant, title, description } = config.toToast(payload, t);
          toast[variant](title, { description });
        }),
      );
    }

    // ─── 3. 复杂事件：有自定义逻辑的事件 ──

    /** mission 状态变更 → 更新 store + 条件 toast */
    unsubs.push(
      subscribe("mission.status_changed", (payload) => {
        const p = payload as { missionId: string; oldStatus: string; newStatus: string };
        const missionStore = useMissionStore.getState();
        missionStore.updateMission(p.missionId, { status: p.newStatus as Mission["status"] });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
        if (p.newStatus === "completed") {
          toast.success(t("events.missionCompleted"));
        }
      }),
    );

    /** mission 任务更新 → 更新 store */
    unsubs.push(
      subscribe("mission.task_updated", (payload) => {
        const p = payload as { missionId: string; taskId: string; status: string; who: string };
        const missionStore = useMissionStore.getState();
        missionStore.updateTask(p.missionId, p.taskId, { status: p.status as MissionTask["status"] });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
      }),
    );

    /** mission 完成 → 更新 store + toast */
    unsubs.push(
      subscribe("mission.completed", (payload) => {
        const p = payload as { missionId: string; goal: string };
        const missionStore = useMissionStore.getState();
        missionStore.updateMission(p.missionId, { status: "completed", progressPercent: 100 });
        queryClient.invalidateQueries({ queryKey: ["missions"] });
        toast.success(t("events.missionAllDone"));
      }),
    );

    /** Agent 间对话 → 写入 agentChatStore */
    unsubs.push(
      subscribe("agent_dialogue", (payload) => {
        const p = payload as {
          id?: string; sessionId?: string; taskId?: string;
          from?: string; to?: string; direction?: string;
          messageType?: string; content?: string; correlationId?: string;
        };
        if (p.id) {
          const agentChatStore = useAgentChatStore.getState();
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
      }),
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [subscribe, queryClient, t]);
}
