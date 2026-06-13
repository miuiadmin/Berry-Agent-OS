/**
 * Tasks 页面的 mutations hooks。
 *
 * 封装任务取消 mutation，统一 invalidate / toast / loading 状态管理。
 * 页面组件只关心调用 mutate，不需要处理 onSuccess / onError 细节。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import { useT } from "@/lib/i18n";

/** 任务 mutations hook：返回 cancelTask mutation */
export function useTaskMutations() {
  const queryClient = useQueryClient();
  const t = useT();

  /** 取消运行中的任务 */
  const cancelTask = useMutation({
    mutationFn: async (taskId: string) => {
      await apiPost(`/api/tasks/${taskId}/cancel`);
    },
    onSuccess: () => {
      /** 任务状态变更后刷新列表 */
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(t("tasks.taskCancelled"));
    },
    onError: (err: Error) => {
      toast.error(err.message || t("tasks.failedToCancel"));
    },
  });

  return { cancelTask };
}
