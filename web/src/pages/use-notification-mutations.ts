/**
 * useNotificationMutations — 通知相关的所有 mutation 集合。
 *
 * 统一封装通知的 3 个 mutation（标记已读 / 全部已读 / 归档），
 * 成功后自动刷新 notifications + count 缓存。
 * 从 NotificationsPage.tsx 提取。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { notificationsApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function useNotificationMutations() {
  const t = useT();
  const qc = useQueryClient();
  /** 刷新通知列表 + 未读数缓存 */
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["notification-count"] });
  };

  /** 标记单条通知为已读 */
  const readMut = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => invalidateAll(),
    onError: (err: Error) => toast.error(err.message),
  });

  /** 标记全部通知为已读 */
  const readAllMut = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => {
      toast.success(t("notifications.allMarkedRead"));
      invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 归档单条通知 */
  const archiveMut = useMutation({
    mutationFn: (id: string) => notificationsApi.archive(id),
    onSuccess: () => {
      toast.success(t("notifications.notificationArchived"));
      invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return { readMut, readAllMut, archiveMut };
}
