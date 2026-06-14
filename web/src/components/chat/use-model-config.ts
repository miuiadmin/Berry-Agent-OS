/**
 * useModelConfig — 模型配置 hook。
 *
 * 拉取当前模型 + channels 列表，提供：
 *  - currentModel：当前选中的模型名（用于显示）
 *  - channels：所有启用渠道（含模型列表）
 *  - allModels：扁平化后的所有可用模型（用于 ModelSelector 下拉）
 *  - isModelConfigured：是否有至少一个"已配置"渠道（至少 1 个模型可发）——chat-window
 *    用它判定输入框是否可用，避免每次 send 才发现无可用模型
 *  - switchModel：切换当前模型（更新 llm 配置 → 刷新缓存 → toast）
 *
 * "已配置" 判定：channel.enabled === true 且 modelCount > 0。
 * 重构前 chat-window.tsx 自己再发一份相同的 ["providers","channels"] 查询做这个判定，
 * 且 predicate 写的是 `ch.configured || modelCount > 0`（configured 字段在
 * ProviderChannel 接口里不存在，恒为 undefined）——本质等价于 modelCount > 0，
 * 但漏掉了 enabled 检查。统一到本 hook 后判定逻辑也一并修正。
 *
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

  /** 所有启用渠道（带模型列表），ModelSelector 下拉的数据源 */
  const channels = channelsData?.channels?.filter((c) => c.enabled) ?? [];
  const allModels: FlatModel[] = channels.flatMap((ch) =>
    ch.models.map((m) => ({
      ...m,
      channelId: ch.id,
      channelName: ch.name,
      kind: ch.kind,
    })),
  );

  /**
   * 是否有至少一个"已配置可用"的渠道：enabled 且 modelCount > 0。
   * chat-window 用它决定输入框是否可发送（无可用模型时禁用，避免发空请求）。
   */
  const isModelConfigured = channels.some((c) => c.modelCount > 0);

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

  return { currentModel, channels, allModels, isModelConfigured, switchModel };
}
