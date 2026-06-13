/**
 * 设置页面的 mutations hooks。
 *
 * 封装配置保存 mutation，统一 invalidate / toast / 回滚到服务端状态。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPut } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function useConfigMutations() {
  const queryClient = useQueryClient();
  const t = useT();

  /** 保存配置到服务端 */
  const saveConfig = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      await apiPut("/api/config", updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success(t("settings.saved"));
    },
    onError: (err: Error) => {
      toast.error(err.message || t("settings.failedToSave"));
      /** 保存失败时刷新缓存，回到服务端状态 */
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  return { saveConfig };
}
