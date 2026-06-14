/**
 * 设置页面的 mutations hooks。
 *
 * 封装配置保存 / 重置 mutations，统一 invalidate / toast / 回滚到服务端状态。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPut } from "@/lib/api";
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

  /**
   * 重置配置为服务端默认值。
   *
   * 走 mutation 层而非页面内裸 `await apiGet`：统一享受 isPending 加载态、
   * 自动 query invalidation、错误 toast，与 saveConfig 行为对齐——
   * 避免页面里出现"保存走 mutation / 重置走裸 fetch"两条不对称的代码路径。
   */
  const resetConfig = useMutation({
    mutationFn: async () => apiGet<Record<string, unknown>>("/api/config/defaults"),
    onSuccess: (defaults) => {
      /** 预填 config query 缓存为默认值，避免重置后短暂闪烁到旧值 */
      queryClient.setQueryData(["config"], defaults);
      toast.info(t("settings.resetToDefaults"));
    },
    onError: () => {
      toast.error(t("settings.failedToLoadDefaults"));
    },
  });

  return { saveConfig, resetConfig };
}
