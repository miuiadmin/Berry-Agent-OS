
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWsStore } from "@/lib/stores/ws-store";

export function useRealtimeEvents() {
  const queryClient = useQueryClient();
  const subscribe = useWsStore((s) => s.subscribe);

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
        toast.error(`Task failed${p.targetAgent ? ` (${p.targetAgent})` : ""}`, {
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
        toast.error(`Agent crashed: ${p.name ?? "unknown"}`, {
          description: p.error,
        });
      })
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [subscribe, queryClient]);
}
