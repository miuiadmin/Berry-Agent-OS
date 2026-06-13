/**
 * Agents 页面的 mutations hooks。
 *
 * 封装 Agent 启用/禁用 mutation，统一 invalidate / toast 管理。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function useAgentMutations() {
  const queryClient = useQueryClient();
  const t = useT();

  /** 启用或禁用指定 Agent */
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

  return { toggleAgent };
}
