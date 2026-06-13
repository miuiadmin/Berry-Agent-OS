/**
 * useSchedulerMutations — 定时任务相关的所有 mutation 集合。
 *
 * 统一封装 scheduler 的 5 个 mutation（创建/删除/暂停/恢复/触发），
 * 成功后自动 toast 提示 + 刷新 jobs 列表缓存。
 * 从 SchedulerPage.tsx 提取。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { schedulerApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function useSchedulerMutations() {
  const t = useT();
  const qc = useQueryClient();
  /** 刷新 jobs 列表缓存 */
  const invalidateJobs = () =>
    qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });

  /** 创建定时任务 */
  const createMut = useMutation({
    mutationFn: schedulerApi.createJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobCreated"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 删除定时任务 */
  const deleteMut = useMutation({
    mutationFn: schedulerApi.deleteJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobDeleted"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 暂停定时任务 */
  const pauseMut = useMutation({
    mutationFn: schedulerApi.pauseJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobPaused"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 恢复定时任务 */
  const resumeMut = useMutation({
    mutationFn: schedulerApi.resumeJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobResumed"));
      invalidateJobs();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 手动触发定时任务 */
  const triggerMut = useMutation({
    mutationFn: schedulerApi.triggerJob,
    onSuccess: () => {
      toast.success(t("scheduler.jobTriggered"));
      invalidateJobs();
      qc.invalidateQueries({ queryKey: ["scheduler-queue"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return { createMut, deleteMut, pauseMut, resumeMut, triggerMut };
}
