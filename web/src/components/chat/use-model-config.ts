/**
 * useModelConfig — 模型配置 hook。
 *
 * 拉取当前模型 + channels 列表，提供 switchModel 切换能力。
 * switchModel 先从 queryClient 读最新缓存，避免闭包捕获过期快照覆盖服务端变更。
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut, queries } from "@/lib/api";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

/** 模型条目（渠道内的单个模型） */
export interface ChannelModel {
  id: string;
  name: string;
}

/** Provider 渠道（含模型列表） */
export interface ProviderChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  modelCount: number;
  models: ChannelModel[];
}

/** 扁平化后的模型（附加渠道信息） */
export interface FlatModel extends ChannelModel {
  channelId: string;
  channelName: string;
  kind: string;
}

export function useModelConfig() {
  const { data: config } = useQuery(queries.config());
  const { data: channelsData } = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: () =>
      apiGet<{ ok: boolean; channels: ProviderChannel[] }>("/api/providers/channels").catch(() => null),
  });
  const queryClient = useQueryClient();
  const llm = config?.llm as Record<string, unknown> | undefined;
  const t = useT();
  const currentModel = (llm?.model as string) || t("chat.notConfigured");

  /** 所有启用渠道的模型列表（扁平化，附加渠道信息） */
  const channels = channelsData?.channels?.filter((c) => c.enabled) ?? [];
  const allModels: FlatModel[] = channels.flatMap((ch) =>
    ch.models.map((m) => ({
      ...m,
      channelId: ch.id,
      channelName: ch.name,
      kind: ch.kind,
    })),
  );

  /** 切换模型（更新 llm 配置 → 刷新缓存 → toast） */
  const switchModel = useCallback(
    async (model: string, channelId?: string) => {
      try {
        const currentConfig =
          queryClient.getQueryData<Record<string, unknown>>(["config"]);
        const currentLlm = (currentConfig?.llm ?? llm) as Record<
          string,
          unknown
        >;
        const update: Record<string, unknown> = { ...currentLlm, model };
        if (channelId) {
          update.channel = channelId;
        }
        await apiPut("/api/config", { llm: update });
        queryClient.invalidateQueries({ queryKey: ["config"] });
        toast.success(t("chat.switchedToModel", { model }));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("chat.failedToSwitch"),
        );
      }
    },
    [llm, queryClient, t],
  );

  return { currentModel, channels, allModels, switchModel };
}
