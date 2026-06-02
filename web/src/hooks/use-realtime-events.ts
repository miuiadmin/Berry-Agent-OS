
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";

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

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [subscribe, queryClient, t]);
}
