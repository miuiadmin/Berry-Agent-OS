/**
 * useProviderMutations — Provider 相关的所有 mutation 集合。
 *
 * 统一 toast 反馈 + 成功后回调（刷新缓存、关闭弹窗等）。
 * 从 providers-tab.tsx 提取，减少主文件体积。
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPost, apiPut, apiDelete } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { ChannelFormData } from "@/components/settings/channel-form-dialog";
import type { TierMapping } from "@/components/settings/providers-types";

export interface ProviderPendingFlags {
  testing: boolean;
  creating: boolean;
  updating: boolean;
  savingTiers: boolean;
}

/**
 * @param onSuccess 成功回调（刷新缓存 + 关闭弹窗 + 重置状态）
 */
export function useProviderMutations(onSuccess: () => void) {
  const t = useT();

  /** 测试渠道连接 */
  const testMutation = useMutation({
    mutationFn: (channelId: string) =>
      apiPost<{ ok: boolean; message?: string; error?: string }>(
        `/api/providers/channels/${channelId}/test`,
      ),
    onSuccess: (data) => {
      if (data.ok) toast.success(t("providers.connectionSuccessful"));
      else toast.error(data.error ?? t("providers.connectionFailed"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 新增渠道 */
  const createMutation = useMutation({
    mutationFn: (data: ChannelFormData) =>
      apiPost<{ ok: boolean; channelId: string }>(
        "/api/providers/channels",
        data,
      ),
    onSuccess: () => {
      toast.success(t("providers.channelCreated"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 更新渠道配置 */
  const updateMutation = useMutation({
    mutationFn: ({
      channelId,
      updates,
    }: {
      channelId: string;
      updates: Record<string, unknown>;
    }) =>
      apiPut<{ ok: boolean }>(`/api/providers/channels/${channelId}`, updates),
    onSuccess: () => {
      toast.success(t("providers.channelUpdated"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 删除渠道 */
  const deleteMutation = useMutation({
    mutationFn: (channelId: string) =>
      apiDelete(`/api/providers/channels/${channelId}`),
    onSuccess: () => {
      toast.success(t("providers.channelDeleted"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 保存 tier 映射 */
  const saveTiersMutation = useMutation({
    mutationFn: (tm: TierMapping) =>
      apiPut<{ ok: boolean; tiers: TierMapping }>("/api/providers/tiers", tm),
    onSuccess: () => {
      toast.success(t("providers.tierMappingSaved"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return {
    testChannel: testMutation.mutate,
    createChannel: createMutation.mutate,
    updateChannel: (channelId: string, updates: Record<string, unknown>) =>
      updateMutation.mutate({ channelId, updates }),
    deleteChannel: deleteMutation.mutate,
    saveTiers: saveTiersMutation.mutate,
    pendingFlags: {
      testing: testMutation.isPending,
      creating: createMutation.isPending,
      updating: updateMutation.isPending,
      savingTiers: saveTiersMutation.isPending,
    },
  };
}
